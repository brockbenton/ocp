/**
 * What the relay sends (votes, attendance mints, Rep credit pages) and what each result
 * does to the records. Check-ins and votes are queued as rows with status PENDING.
 */
import type { CheckIn, RelayTx, Session, Vote } from '@prisma/client';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, keccak256 } from 'viem';
import { GOVERNOR_ABI, REGISTRY_ABI } from '../lib/abi';
import { addresses } from '../lib/config';
import { currentRegistry } from '../lib/session';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import {
  getPauseState,
  getSignOffOnChain,
  getVoteContext,
  hasRelayRole,
  hasVotedOnChain,
  tokenBalanceOnChain,
} from './onchain.service';
import { isRevert, reconcile, submit, type RelayOutcome, type RelayPayload } from './relay.service';

export const MAX_MINT_BATCH = 200;
export const CREDIT_PAGE = 100;
const MAX_ATTEMPTS = 5;
/** `IAttendanceRegistry2.SkipReason` */
const SKIPPED_ALREADY_CHECKED_IN = 1;

const errorText = (err: unknown) =>
  ((err as { shortMessage?: string }).shortMessage ?? (err as Error).message).slice(0, 300);

// ── Votes ────────────────────────────────────────────────────────────────

export function voteCall(vote: { proposalId: string; support: number; voter: string; signature: string }) {
  return {
    to: addresses.governor,
    data: encodeFunctionData({
      abi: GOVERNOR_ABI,
      functionName: 'castVoteBySig',
      args: [
        BigInt(vote.proposalId),
        vote.support,
        getAddress(vote.voter),
        vote.signature as `0x${string}`,
      ],
    }),
  };
}

async function failVote(vote: Vote, reason: string): Promise<void> {
  await prisma.vote.update({
    where: { id: vote.id },
    data: { status: 'FAILED', failureReason: reason, relayTxId: null },
  });
  logger.warn({ msg: 'Relayed vote failed', proposalId: vote.proposalId, voter: vote.voter, reason });
}

async function sendVotes(): Promise<void> {
  const queued = await prisma.vote.findMany({
    where: { status: 'PENDING', relayTxId: null, signature: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const vote of queued) {
    try {
      const context = await getVoteContext(vote.proposalId, vote.voter);
      if (context.hasVoted) {
        // Someone else submitted it, which any wallet may do.
        await prisma.vote.update({ where: { id: vote.id }, data: { status: 'CONFIRMED' } });
        continue;
      }
      if (context.state !== 'Active') {
        await failVote(vote, `Voting is not open (proposal is ${context.state})`);
        continue;
      }
      const tx = await submit({ kind: 'VOTE', ...voteCall({ ...vote, signature: vote.signature! }), meta: { voteId: vote.id } });
      if (!tx) continue;
      await prisma.vote.update({ where: { id: vote.id }, data: { status: 'SUBMITTED', relayTxId: tx.id } });
    } catch (err) {
      logger.warn({ msg: 'Could not relay vote', voteId: vote.id, err: errorText(err) });
      if (!isRevert(err)) continue;
      const attempts = vote.attempts + 1;
      await prisma.vote.update({ where: { id: vote.id }, data: { attempts } });
      if (attempts >= MAX_ATTEMPTS) await failVote(vote, errorText(err));
    }
  }
}

async function settleVote(tx: RelayTx, payload: RelayPayload, outcome: RelayOutcome): Promise<void> {
  const vote = await prisma.vote.findUnique({ where: { id: payload.meta.voteId as string } });
  if (!vote || vote.relayTxId !== tx.id) return;
  if (outcome.status === 'success') {
    await prisma.vote.update({
      where: { id: vote.id },
      data: { status: 'CONFIRMED', txHash: outcome.receipt.transactionHash },
    });
    return;
  }
  if (await hasVotedOnChain(vote.proposalId, vote.voter)) {
    await prisma.vote.update({ where: { id: vote.id }, data: { status: 'CONFIRMED' } });
    return;
  }
  const attempts = vote.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return failVote(vote, 'The relay could not get the vote mined');
  await prisma.vote.update({
    where: { id: vote.id },
    data: { status: 'PENDING', relayTxId: null, attempts },
  });
}

// ── Mints ────────────────────────────────────────────────────────────────

type QueuedCheckIn = CheckIn & { member: { walletAddress: string }; session: Session };

async function failCheckIns(ids: string[], failureReason: string): Promise<void> {
  if (ids.length === 0) return;
  await prisma.checkIn.updateMany({
    where: { id: { in: ids }, mintStatus: { not: 'CONFIRMED' } },
    data: { mintStatus: 'FAILED', failureReason, relayTxId: null },
  });
  logger.warn({ msg: 'Check-ins failed', count: ids.length, reason: failureReason });
}

/** Sends one session's queued check-ins as a single `mintBatch`. */
async function sendSessionMints(checkIns: QueuedCheckIn[]): Promise<void> {
  const { session } = checkIns[0];
  // A token may exist already (an earlier attempt); that check-in succeeded.
  const unminted: QueuedCheckIn[] = [];
  for (const checkIn of checkIns) {
    if ((await tokenBalanceOnChain(checkIn.member.walletAddress, session.sessionIdOnchain)) > 0n) {
      await prisma.checkIn.update({ where: { id: checkIn.id }, data: { mintStatus: 'CONFIRMED' } });
    } else {
      unminted.push(checkIn);
    }
  }
  if (unminted.length === 0) return;

  const signOff = await getSignOffOnChain(session.sessionIdOnchain);
  if (signOff.status !== 'NONE') {
    await failCheckIns(unminted.map((c) => c.id), 'The session closed before the token was minted');
    return;
  }

  const tx = await submit({
    kind: 'MINT_BATCH',
    to: addresses.registry,
    data: encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: 'mintBatch',
      args: [unminted.map((c) => getAddress(c.member.walletAddress)), BigInt(session.sessionIdOnchain)],
    }),
    meta: { checkInIds: unminted.map((c) => c.id) },
  });
  if (!tx) return;
  await prisma.checkIn.updateMany({
    where: { id: { in: unminted.map((c) => c.id) }, mintStatus: 'PENDING' },
    data: { mintStatus: 'SUBMITTED', relayTxId: tx.id },
  });
}

async function sendMints(): Promise<void> {
  const queued = await prisma.checkIn.findMany({
    where: { mintStatus: 'PENDING', session: { registryAddress: currentRegistry() } },
    include: { member: { select: { walletAddress: true } }, session: true },
    orderBy: { checkedInAt: 'asc' },
    take: 1000,
  });
  if (queued.length === 0) return;
  // Without the role (for example mid-rotation) every mint would revert: keep them queued.
  if (!(await hasRelayRole())) {
    logger.error({ msg: 'Relay wallet has no RELAY_ROLE; check-ins are waiting', waiting: queued.length });
    return;
  }
  // Minting reverts while paused; check-ins wait for the pause to end or the session to close.
  const { paused } = await getPauseState();

  const bySession = new Map<string, QueuedCheckIn[]>();
  for (const checkIn of queued) {
    bySession.set(checkIn.sessionId, [...(bySession.get(checkIn.sessionId) ?? []), checkIn]);
  }
  for (const checkIns of bySession.values()) {
    const batch = checkIns.slice(0, MAX_MINT_BATCH);
    try {
      if (paused) {
        const signOff = await getSignOffOnChain(batch[0].session.sessionIdOnchain);
        if (signOff.status !== 'NONE') await sendSessionMints(checkIns);
        continue;
      }
      await sendSessionMints(batch);
    } catch (err) {
      logger.error({ msg: 'Could not send mint batch', sessionId: batch[0].session.sessionIdOnchain, err: errorText(err) });
      // An outage must not cost anyone their attendance.
      if (!isRevert(err)) continue;
      for (const checkIn of batch) {
        const attempts = checkIn.attempts + 1;
        await prisma.checkIn.updateMany({
          where: { id: checkIn.id, mintStatus: 'PENDING' },
          data: { attempts },
        });
        if (attempts >= MAX_ATTEMPTS) await failCheckIns([checkIn.id], errorText(err));
      }
    }
  }
}

async function settleMints(tx: RelayTx, payload: RelayPayload, outcome: RelayOutcome): Promise<void> {
  const checkIns = await prisma.checkIn.findMany({
    where: { id: { in: payload.meta.checkInIds as string[] }, relayTxId: tx.id },
    include: { member: { select: { walletAddress: true } } },
  });

  if (outcome.status !== 'success') {
    for (const checkIn of checkIns) {
      const attempts = checkIn.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await failCheckIns([checkIn.id], 'The relay could not mint the token');
      } else {
        await prisma.checkIn.update({
          where: { id: checkIn.id },
          data: { mintStatus: 'PENDING', relayTxId: null, attempts },
        });
      }
    }
    return;
  }

  // `mintBatch` succeeds even when it skips an account, so read each account's own event.
  const results = new Map<string, number | 'minted'>();
  for (const log of outcome.receipt.logs) {
    if (log.address.toLowerCase() !== currentRegistry()) continue;
    try {
      const event = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      if (event.eventName === 'TokenMinted') results.set(event.args.to.toLowerCase(), 'minted');
      if (event.eventName === 'TokenMintSkipped') {
        results.set(event.args.to.toLowerCase(), event.args.reason);
      }
    } catch {
      // Not one of the events in the ABI.
    }
  }

  for (const checkIn of checkIns) {
    const result = results.get(checkIn.member.walletAddress);
    if (result === 'minted' || result === SKIPPED_ALREADY_CHECKED_IN) {
      await prisma.checkIn.update({
        where: { id: checkIn.id },
        data: { mintStatus: 'CONFIRMED', txHash: outcome.receipt.transactionHash },
      });
    } else {
      await failCheckIns([checkIn.id], 'The session reached its attendee cap');
    }
  }
}

// ── Rep credit ───────────────────────────────────────────────────────────

export function attendeesHashOf(attendees: string[]): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: 'address[]' }], [attendees.map((a) => getAddress(a))]),
  );
}

/** Credits confirmed sessions one page at a time; the on-chain cursor makes retries safe. */
async function sendCreditPages(): Promise<void> {
  const sessions = await prisma.session.findMany({
    where: { registryAddress: currentRegistry(), repStatus: 'CONFIRMED' },
    orderBy: { recognizedAt: 'asc' },
  });
  if (sessions.length === 0) return;
  const inFlight = await prisma.relayTx.findMany({
    where: { kind: 'CREDIT_PAGE', activeKey: { not: null } },
  });
  const busy = new Set(
    inFlight.map((tx) => (tx.payload as unknown as RelayPayload).meta.sessionId as string),
  );

  for (const session of sessions) {
    if (busy.has(session.id)) continue;
    try {
      const signOff = await getSignOffOnChain(session.sessionIdOnchain);
      if (signOff.status !== 'CONFIRMED') continue;
      if (attendeesHashOf(session.attendees) !== signOff.attendeesHash) {
        logger.error({ msg: 'Indexed attendee list does not match the chain', sessionId: session.sessionIdOnchain });
        continue;
      }
      const from = signOff.cursor;
      const to = Math.min(from + CREDIT_PAGE, signOff.count);
      await submit({
        kind: 'CREDIT_PAGE',
        to: addresses.registry,
        data: encodeFunctionData({
          abi: REGISTRY_ABI,
          functionName: 'creditSessionRep',
          args: [BigInt(session.sessionIdOnchain), session.attendees.map((a) => getAddress(a)), from, to],
        }),
        meta: { sessionId: session.id, from, to },
      });
    } catch (err) {
      logger.error({ msg: 'Could not send credit page', sessionId: session.sessionIdOnchain, err: errorText(err) });
    }
  }
}

async function settleCreditPage(payload: RelayPayload): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: payload.meta.sessionId as string } });
  if (!session) return;
  // Read the cursor rather than assuming: anyone may have submitted a page.
  const signOff = await getSignOffOnChain(session.sessionIdOnchain);
  await prisma.session.update({
    where: { id: session.id },
    data: { creditCursor: signOff.cursor, repStatus: signOff.status },
  });
}

// ── Tick ─────────────────────────────────────────────────────────────────

async function settle(tx: RelayTx, payload: RelayPayload, outcome: RelayOutcome): Promise<void> {
  if (tx.kind === 'VOTE') return settleVote(tx, payload, outcome);
  if (tx.kind === 'MINT_BATCH') return settleMints(tx, payload, outcome);
  return settleCreditPage(payload);
}

/** One pass of the relay: settle what finished, then send what is queued. */
export async function relayTick(): Promise<void> {
  await reconcile(settle);
  // Votes first: they have a deadline.
  await sendVotes();
  await sendMints();
  await sendCreditPages();
}
