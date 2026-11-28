/**
 * The single relay sender. Every transaction the backend pays for goes through here.
 *
 * - Nonces are assigned locally, so transactions are sent without waiting for earlier ones.
 * - A row is written (with the signed hash) before broadcasting, so a crash or restart
 *   resumes exactly where it was. A unique key on the nonce stops double use.
 * - The oldest unmined transaction is replaced with a higher fee once it is stuck, or
 *   cancelled (a zero-value transfer to self) if it would now revert. At the fee ceiling
 *   it is sent again unchanged.
 * - After a key rotation, work the previous wallet left unmined is released and re-sent.
 * - A result counts only after the configured number of confirmations.
 */
import { Prisma, type RelayKind, type RelayTx } from '@prisma/client';
import { BaseError, keccak256, type Hex, type TransactionReceipt } from 'viem';
import { chain, publicClient, relayAccount, relayWalletClient } from '../lib/contract';
import { settings } from '../lib/config';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

export interface RelayCall {
  kind: RelayKind;
  to: `0x${string}`;
  data: Hex;
  /** What the result handler needs to update records. */
  meta: Prisma.InputJsonObject;
}

export interface RelayPayload {
  to: `0x${string}`;
  data: Hex;
  meta: Record<string, unknown>;
  cancelHashes?: Hex[];
}

/** `success` is the only outcome in which the call took effect. */
export type RelayOutcome =
  | { status: 'success'; receipt: TransactionReceipt }
  | { status: 'reverted' | 'cancelled' | 'dropped' };

export type OutcomeHandler = (tx: RelayTx, payload: RelayPayload, outcome: RelayOutcome) => Promise<void>;

const CANCEL_GAS = 21_000n;
const UNIQUE_VIOLATION = 'P2002';

interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

async function currentFees(): Promise<Fees> {
  const estimate = await publicClient.estimateFeesPerGas();
  const cap = settings.relayMaxFeePerGas;
  const maxFeePerGas = min(estimate.maxFeePerGas, cap);
  return { maxFeePerGas, maxPriorityFeePerGas: min(estimate.maxPriorityFeePerGas, maxFeePerGas) };
}

/** Nodes reject a replacement unless both fees rise by at least 10%; use 25%, up to the cap. */
export function bumpedFees(previous: Fees, current: Fees, cap: bigint): Fees | null {
  const raise = (value: bigint) => (value * 125n) / 100n + 1n;
  const maxFeePerGas = min(max(raise(previous.maxFeePerGas), current.maxFeePerGas), cap);
  const maxPriorityFeePerGas = min(
    max(raise(previous.maxPriorityFeePerGas), current.maxPriorityFeePerGas),
    maxFeePerGas,
  );
  const enough = (next: bigint, last: bigint) => next * 10n >= last * 11n;
  return enough(maxFeePerGas, previous.maxFeePerGas) &&
    enough(maxPriorityFeePerGas, previous.maxPriorityFeePerGas)
    ? { maxFeePerGas, maxPriorityFeePerGas }
    : null;
}

async function sign(
  nonce: number,
  request: { to: `0x${string}`; data: Hex; gas: bigint } & Fees,
): Promise<{ raw: Hex; hash: Hex }> {
  const raw = await relayWalletClient.signTransaction({
    account: relayAccount,
    chain,
    type: 'eip1559',
    nonce,
    value: 0n,
    ...request,
  });
  return { raw, hash: keccak256(raw) };
}

async function broadcast(raw: Hex, context: Record<string, unknown>): Promise<void> {
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: raw });
  } catch (err) {
    // The hash is already recorded; reconciliation resends or replaces it.
    logger.warn({ msg: 'Relay broadcast failed', err: (err as Error).message, ...context });
  }
}

async function nextNonce(): Promise<number> {
  const [pending, latestRow] = await Promise.all([
    publicClient.getTransactionCount({ address: relayAccount.address, blockTag: 'pending' }),
    prisma.relayTx.findFirst({
      where: { sender: relayAccount.address, activeKey: { not: null } },
      orderBy: { nonce: 'desc' },
      select: { nonce: true },
    }),
  ]);
  return Math.max(pending, latestRow ? latestRow.nonce + 1 : 0);
}

const REVERT_ERRORS = new Set(['ExecutionRevertedError', 'ContractFunctionRevertedError']);

/**
 * True if the chain itself rejected a call. Anything else (RPC outage, timeout, empty
 * wallet) says nothing about the work, which should simply be retried later.
 */
export function isRevert(err: unknown): boolean {
  return err instanceof BaseError && err.walk((cause) => REVERT_ERRORS.has((cause as Error).name)) !== null;
}

/** Throws with the revert reason if the call would fail right now. */
export async function simulate(to: `0x${string}`, data: Hex): Promise<void> {
  await publicClient.call({ account: relayAccount.address, to, data });
}

/**
 * Simulates, records and broadcasts one call without waiting for it to be mined.
 * Throws if the simulation fails, so nothing that cannot succeed is paid for.
 * Returns null if another sender took the nonce; the work stays queued.
 */
export async function submit(call: RelayCall): Promise<RelayTx | null> {
  await simulate(call.to, call.data);
  const [estimate, fees, nonce] = await Promise.all([
    publicClient.estimateGas({ account: relayAccount.address, to: call.to, data: call.data }),
    currentFees(),
    nextNonce(),
  ]);
  // Headroom for state that changes between estimation and inclusion.
  const gas = (estimate * 12n) / 10n;
  const signed = await sign(nonce, { to: call.to, data: call.data, gas, ...fees });
  const payload: RelayPayload = { to: call.to, data: call.data, meta: call.meta };

  let row: RelayTx;
  try {
    row = await prisma.relayTx.create({
      data: {
        sender: relayAccount.address,
        nonce,
        activeKey: `${relayAccount.address}:${nonce}`,
        kind: call.kind,
        payload: payload as unknown as Prisma.InputJsonValue,
        hashes: [signed.hash],
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        gas: gas.toString(),
        status: 'SUBMITTED',
        lastSentAt: new Date(),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) return null;
    throw err;
  }
  await broadcast(signed.raw, { nonce, kind: call.kind });
  logger.info({ msg: 'Relay tx submitted', kind: call.kind, nonce, hash: signed.hash });
  return row;
}

async function findReceipt(hashes: string[]): Promise<TransactionReceipt | null> {
  // Newest first: the latest replacement is the likeliest to have been mined.
  for (const hash of [...hashes].reverse()) {
    try {
      return await publicClient.getTransactionReceipt({ hash: hash as Hex });
    } catch (err) {
      if ((err as Error).name !== 'TransactionReceiptNotFoundError') throw err;
    }
  }
  return null;
}

async function resolve(
  tx: RelayTx,
  outcome: RelayOutcome,
  handle: OutcomeHandler,
  error?: string,
): Promise<void> {
  const status = {
    success: 'CONFIRMED',
    reverted: 'REVERTED',
    cancelled: 'CANCELLED',
    dropped: 'DROPPED',
  } as const;
  // Records are updated first: if this is interrupted the row stays active and is retried.
  await handle(tx, tx.payload as unknown as RelayPayload, outcome);
  await prisma.relayTx.update({
    where: { id: tx.id },
    data: { status: status[outcome.status], activeKey: null, error },
  });
  logger.info({ msg: 'Relay tx resolved', kind: tx.kind, nonce: tx.nonce, outcome: outcome.status });
}

/** Re-signs the oldest stuck transaction with a higher fee, or cancels it. */
async function replace(tx: RelayTx): Promise<void> {
  const payload = tx.payload as unknown as RelayPayload;
  const previous = {
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  };
  const requestFor = (cancel: boolean) =>
    cancel
      ? { to: relayAccount.address, data: '0x' as Hex, gas: CANCEL_GAS }
      : { to: payload.to, data: payload.data, gas: BigInt(tx.gas) };
  const fees = bumpedFees(previous, await currentFees(), settings.relayMaxFeePerGas);
  if (!fees) {
    logger.error({
      msg: 'Relay tx is stuck at the fee ceiling; raise RELAY_MAX_FEE_GWEI or wait',
      nonce: tx.nonce,
      maxFeePerGas: tx.maxFeePerGas,
    });
    // The earlier broadcasts may never have reached the network (an empty wallet, an
    // RPC outage), so send it again. The same inputs sign to the same transaction.
    const same = await sign(tx.nonce, { ...requestFor(tx.cancelled), ...previous });
    await prisma.relayTx.update({
      where: { id: tx.id },
      data: {
        hashes: tx.hashes.includes(same.hash) ? undefined : { push: same.hash },
        lastSentAt: new Date(),
      },
    });
    await broadcast(same.raw, { nonce: tx.nonce, resend: true });
    return;
  }

  // Cancel only if the chain rejects the call. A node that cannot answer says nothing.
  const cancel =
    tx.cancelled || (await simulate(payload.to, payload.data).then(() => false, isRevert));
  const signed = await sign(tx.nonce, { ...requestFor(cancel), ...fees });

  await prisma.relayTx.update({
    where: { id: tx.id },
    data: {
      hashes: { push: signed.hash },
      cancelled: cancel,
      payload: {
        ...payload,
        cancelHashes: cancel ? [...(payload.cancelHashes ?? []), signed.hash] : payload.cancelHashes,
      } as unknown as Prisma.InputJsonValue,
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      lastSentAt: new Date(),
    },
  });
  await broadcast(signed.raw, { nonce: tx.nonce, replacement: true });
  logger.warn({
    msg: cancel ? 'Cancelling stuck relay tx' : 'Replacing stuck relay tx',
    nonce: tx.nonce,
    hash: signed.hash,
  });
}

/** Settles finished transactions and unsticks the head of the nonce queue. */
export async function reconcile(handle: OutcomeHandler): Promise<void> {
  const active = await prisma.relayTx.findMany({
    where: { activeKey: { not: null } },
    orderBy: { nonce: 'asc' },
  });
  if (active.length === 0) return;

  const [head, minedCount] = await Promise.all([
    publicClient.getBlockNumber({ cacheTime: 0 }),
    publicClient.getTransactionCount({ address: relayAccount.address, blockTag: 'latest' }),
  ]);

  for (const tx of active) {
    const receipt = await findReceipt(tx.hashes);
    const stuck = Date.now() - (tx.lastSentAt?.getTime() ?? 0) >= settings.relayStuckAfterMs;

    if (receipt) {
      if (head - receipt.blockNumber + 1n < BigInt(settings.confirmations)) continue;
      const cancelled = (tx.payload as unknown as RelayPayload).cancelHashes?.includes(
        receipt.transactionHash,
      );
      if (cancelled) await resolve(tx, { status: 'cancelled' }, handle);
      else if (receipt.status === 'success') await resolve(tx, { status: 'success', receipt }, handle);
      else await resolve(tx, { status: 'reverted' }, handle, 'Reverted on-chain');
      continue;
    }

    if (tx.sender !== relayAccount.address) {
      // This key cannot replace it. Re-sending the work is safe: each kind checks the
      // chain first, in case the old transaction is mined after all.
      if (stuck) await resolve(tx, { status: 'dropped' }, handle, 'Sent by a previous relay wallet');
      continue;
    }

    if (tx.nonce < minedCount) {
      // The nonce was consumed by a transaction we have no receipt for. Allow for an RPC
      // that lags before giving up on it.
      if (stuck) await resolve(tx, { status: 'dropped' }, handle, 'Nonce used by another transaction');
      continue;
    }

    // Only the lowest unmined nonce can be holding the queue up.
    if (tx.nonce === minedCount && stuck) await replace(tx);
  }
}
