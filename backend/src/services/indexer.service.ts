/**
 * Mirrors registry, Rep, Governor and Timelock events into the database. One worker, one
 * cursor, and only blocks that are `confirmations` deep. Every write is idempotent, so a
 * chunk can safely be applied twice.
 */
import type { Prisma, RepEventType } from '@prisma/client';
import {
  encodeAbiParameters,
  decodeEventLog,
  keccak256,
  pad,
  stringToBytes,
  toHex,
  zeroHash,
  type Abi,
  type Log,
} from 'viem';
import { GOVERNOR_ABI, REGISTRY_ABI, REP_ABI, TIMELOCK_ABI } from '../lib/abi';
import { addresses, settings } from '../lib/config';
import { publicClient } from '../lib/contract';
import { currentRegistry } from '../lib/session';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

type Tx = Prisma.TransactionClient;

interface DecodedEvent {
  source: 'registry' | 'rep' | 'governor' | 'timelock';
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  at: Date;
}

const SKIPPED_ALREADY_CHECKED_IN = 1;

const lower = (value: unknown) => String(value).toLowerCase();
const fromSeconds = (value: unknown) => new Date(Number(value) * 1000);

/** The Timelock operation id the Governor uses when it queues a proposal. */
export function operationIdFor(
  governor: `0x${string}`,
  targets: readonly `0x${string}`[],
  values: readonly bigint[],
  calldatas: readonly `0x${string}`[],
  description: string,
): `0x${string}` {
  const salt = toHex(
    BigInt(pad(governor, { dir: 'right', size: 32 })) ^ BigInt(keccak256(stringToBytes(description))),
    { size: 32 },
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address[]' },
        { type: 'uint256[]' },
        { type: 'bytes[]' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [targets, values, calldatas, zeroHash, salt],
    ),
  );
}

async function applyRegistry(tx: Tx, event: DecodedEvent): Promise<void> {
  const { name, args, at, txHash } = event;
  if (args.sessionId === undefined) return;
  const registryAddress = currentRegistry();
  const sessionIdOnchain = String(args.sessionId);
  const key = { registryAddress_sessionIdOnchain: { registryAddress, sessionIdOnchain } };
  const update = (data: Prisma.SessionUpdateManyMutationInput) =>
    tx.session.updateMany({ where: { registryAddress, sessionIdOnchain }, data });

  if (name === 'SessionCreated') {
    const fields = {
      name: String(args.name),
      date: fromSeconds(args.date),
      semester: String(args.semester),
      createdBy: lower(args.createdBy),
      maxAttendees: Number(args.maxAttendees),
      onchainStatus: 'CONFIRMED' as const,
      txHash,
      createdAt: at,
    };
    await tx.session.upsert({
      where: key,
      create: { registryAddress, sessionIdOnchain, ...fields },
      update: fields,
    });
  } else if (name === 'SessionMetadataUpdated') {
    await update({ metadataCid: String(args.cid) || null });
  } else if (name === 'SessionClosed') {
    await update({
      closedAt: at,
      closeTxHash: txHash,
      closedBy: lower(args.closer),
      attendeesHash: String(args.attendeesHash),
      attendees: (args.attendees as string[]).map(lower),
    });
    // Never move a later status backwards when a chunk is replayed.
    await tx.session.updateMany({
      where: { registryAddress, sessionIdOnchain, repStatus: 'NONE' },
      data: { repStatus: 'PENDING' },
    });
  } else if (name === 'SessionRepConfirmed') {
    await update({ confirmedBy: lower(args.confirmer), recognizedAt: fromSeconds(args.recognizedAt) });
    await tx.session.updateMany({
      where: { registryAddress, sessionIdOnchain, repStatus: { in: ['NONE', 'PENDING'] } },
      data: { repStatus: 'CONFIRMED' },
    });
  } else if (name === 'SessionRepRejected') {
    await update({ repStatus: 'REJECTED' });
  } else if (name === 'SessionRepPage') {
    await tx.session.updateMany({
      where: { registryAddress, sessionIdOnchain, creditCursor: { lt: Number(args.to) } },
      data: { creditCursor: Number(args.to) },
    });
  } else if (name === 'SessionRepCredited') {
    await update({ repStatus: 'CREDITED' });
  } else if (name === 'TokenMinted' || name === 'TokenMintSkipped') {
    const account = lower(args.to);
    const minted = name === 'TokenMinted';
    const data = {
      registryAddress,
      sessionIdOnchain,
      account,
      minted,
      skipReason: minted ? null : Number(args.reason),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      txHash,
      occurredAt: at,
    };
    await tx.tokenEvent.upsert({
      where: { txHash_logIndex: { txHash, logIndex: event.logIndex } },
      create: data,
      update: data,
    });
    if (minted || Number(args.reason) === SKIPPED_ALREADY_CHECKED_IN) {
      // Covers mints this relay did not track, e.g. after a lost record.
      await tx.checkIn.updateMany({
        where: {
          member: { walletAddress: account },
          session: { registryAddress, sessionIdOnchain },
          mintStatus: { not: 'CONFIRMED' },
        },
        data: { mintStatus: 'CONFIRMED', ...(minted ? { txHash } : {}) },
      });
    }
  }
}

const REP_EVENT_TYPES: Record<string, RepEventType> = {
  RepCredited: 'CREDIT',
  RepCreditSkipped: 'SKIPPED',
  RepGranted: 'GRANT',
  RepRevoked: 'REVOKE',
  RepUnblocked: 'UNBLOCK',
  LegacyRepImported: 'IMPORT',
};

async function applyRep(tx: Tx, event: DecodedEvent): Promise<void> {
  const type = REP_EVENT_TYPES[event.name];
  if (!type) return;
  const { args, txHash, logIndex } = event;
  const data = {
    type,
    account: lower(args.account),
    amount: type === 'SKIPPED' || type === 'UNBLOCK' ? '0' : String(args.amount),
    nominal: args.nominalAmount === undefined ? null : String(args.nominalAmount),
    recognizedAt: args.recognizedAt === undefined ? null : fromSeconds(args.recognizedAt),
    reason: args.reasonURI === undefined ? null : String(args.reasonURI),
    blockNumber: event.blockNumber,
    logIndex,
    txHash,
    occurredAt: event.at,
  };
  await tx.repEvent.upsert({
    where: { txHash_logIndex: { txHash, logIndex } },
    create: data,
    update: data,
  });
}

async function applyGovernor(tx: Tx, event: DecodedEvent): Promise<void> {
  const { name, args, at, txHash } = event;
  if (name === 'ProposalCreated') {
    const proposalId = String(args.proposalId);
    const targets = args.targets as `0x${string}`[];
    const values = args.values as bigint[];
    const calldatas = args.calldatas as `0x${string}`[];
    const description = String(args.description);
    const data = {
      governor: lower(addresses.governor),
      proposer: lower(args.proposer),
      targets: [...targets],
      values: values.map(String),
      calldatas: [...calldatas],
      description,
      voteStart: fromSeconds(args.voteStart),
      voteEnd: fromSeconds(args.voteEnd),
      operationId: operationIdFor(addresses.governor, targets, values, calldatas, description),
      createdAt: at,
      txHash,
    };
    await tx.proposal.upsert({ where: { proposalId }, create: { proposalId, ...data }, update: data });
  } else if (name === 'VoteCast' || name === 'VoteCastWithParams') {
    const proposalId = String(args.proposalId);
    const voter = lower(args.voter);
    const data = {
      support: Number(args.support),
      weight: String(args.weight),
      status: 'CONFIRMED' as const,
      txHash,
      failureReason: null,
    };
    await tx.vote.upsert({
      where: { proposalId_voter: { proposalId, voter } },
      create: { proposalId, voter, createdAt: at, ...data },
      update: data,
    });
  } else if (name === 'ProposalQueued') {
    await tx.proposal.updateMany({
      where: { proposalId: String(args.proposalId) },
      data: { queuedEta: fromSeconds(args.etaSeconds) },
    });
  } else if (name === 'ProposalExecuted') {
    await tx.proposal.updateMany({ where: { proposalId: String(args.proposalId) }, data: { executedAt: at } });
  } else if (name === 'ProposalCanceled') {
    await tx.proposal.updateMany({ where: { proposalId: String(args.proposalId) }, data: { canceledAt: at } });
  }
}

/** A guardian veto cancels in the Timelock only; the Governor emits nothing. */
async function applyTimelock(tx: Tx, event: DecodedEvent): Promise<void> {
  if (event.name !== 'Cancelled') return;
  await tx.proposal.updateMany({
    where: { operationId: String(event.args.id), canceledAt: null },
    data: { canceledAt: event.at },
  });
}

const APPLY = {
  registry: applyRegistry,
  rep: applyRep,
  governor: applyGovernor,
  timelock: applyTimelock,
} as const;

async function fetchEvents(fromBlock: bigint, toBlock: bigint): Promise<DecodedEvent[]> {
  const sources: { source: DecodedEvent['source']; address: `0x${string}`; abi: Abi }[] = [
    { source: 'registry', address: addresses.registry, abi: REGISTRY_ABI as Abi },
    { source: 'rep', address: addresses.rep, abi: REP_ABI as Abi },
    { source: 'governor', address: addresses.governor, abi: GOVERNOR_ABI as Abi },
    { source: 'timelock', address: addresses.timelock, abi: TIMELOCK_ABI as Abi },
  ];
  const logs: Log[] = await publicClient.getLogs({
    address: sources.map((s) => s.address),
    fromBlock,
    toBlock,
  });

  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!))];
  const times = new Map(
    await Promise.all(
      blockNumbers.map(async (blockNumber) => {
        const block = await publicClient.getBlock({ blockNumber });
        return [blockNumber, fromSeconds(block.timestamp)] as const;
      }),
    ),
  );

  return logs
    .flatMap((log): DecodedEvent[] => {
      const origin = sources.find((s) => s.address.toLowerCase() === log.address.toLowerCase());
      if (!origin) return [];
      try {
        const decoded = decodeEventLog({ abi: origin.abi, data: log.data, topics: log.topics });
        return [
          {
            source: origin.source,
            name: String(decoded.eventName),
            args: (decoded.args ?? {}) as unknown as Record<string, unknown>,
            blockNumber: log.blockNumber!,
            logIndex: log.logIndex!,
            txHash: log.transactionHash!,
            at: times.get(log.blockNumber!)!,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
}

/**
 * Indexes the next chunk of confirmed blocks.
 * @returns true if more confirmed blocks are waiting.
 */
export async function indexNextChunk(): Promise<boolean> {
  const id = currentRegistry();
  const [cursor, latest] = await Promise.all([
    prisma.indexerCursor.findUnique({ where: { id } }),
    publicClient.getBlockNumber({ cacheTime: 0 }),
  ]);
  const confirmed = latest - BigInt(settings.confirmations) + 1n;
  const from = cursor ? cursor.blockNumber + 1n : settings.indexerStartBlock;
  if (from > confirmed) return false;
  const chunkEnd = from + settings.indexerBlockChunk - 1n;
  const to = chunkEnd < confirmed ? chunkEnd : confirmed;

  const events = await fetchEvents(from, to);
  await prisma.$transaction(
    async (tx) => {
      for (const event of events) await APPLY[event.source](tx, event);
      await tx.indexerCursor.upsert({
        where: { id },
        create: { id, blockNumber: to },
        update: { blockNumber: to },
      });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  if (events.length > 0) {
    logger.info({ msg: 'Indexed events', from: from.toString(), to: to.toString(), count: events.length });
  }
  return to < confirmed;
}

/** Catches up to the confirmed head. */
export async function indexToHead(): Promise<void> {
  while (await indexNextChunk()) {
    // Each pass advances the cursor by one chunk.
  }
}
