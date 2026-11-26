import type { RepEvent, Session } from '@prisma/client';
import { currentRegistry } from '../lib/session';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { getRepSnapshot, type RepSnapshot } from './onchain.service';

// The club-wide read is one call per member, so it is cached briefly. Rep decays
// continuously, so a cached figure is only ever shown with the time it was read. A single
// member's page is not cached: they expect to see a credit as soon as it lands.
const CACHE_MS = 15_000;
let cache: { key: string; at: number; snapshot: RepSnapshot } | null = null;

/** Balances for these wallets at one block, or null if the chain cannot be read. */
export async function getRepSnapshotCached(wallets: string[]): Promise<RepSnapshot | null> {
  const key = [...wallets].sort().join(',');
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.snapshot;
  try {
    const snapshot = await getRepSnapshot(wallets);
    cache = { key, at: Date.now(), snapshot };
    return snapshot;
  } catch (err) {
    logger.error({ msg: 'Could not read Rep from chain', err: (err as Error).message });
    return null;
  }
}

export type TokenRepStatus =
  /** Recorded on an earlier registry; counted by the one-time import. */
  | 'LEGACY'
  /** The meeting has not been closed. */
  | 'OPEN'
  /** Closed, waiting for a second officer. Zero voting power. */
  | 'PENDING_APPROVAL'
  /** Approved; the relay has not yet credited this wallet's page. */
  | 'AWAITING_CREDIT'
  | 'CREDITED'
  | 'REJECTED'
  /** Holds the token but was left off the attendee list. */
  | 'NOT_LISTED';

export function tokenRepStatus(
  session: Pick<Session, 'registryAddress' | 'repStatus' | 'attendees' | 'creditCursor' | 'closeTxHash'>,
  wallet: string,
): TokenRepStatus {
  if (session.registryAddress !== currentRegistry()) return 'LEGACY';
  if (session.repStatus === 'NONE') return 'OPEN';
  if (session.repStatus === 'REJECTED') return 'REJECTED';
  // The list arrives with the indexed close event; until then, don't claim anyone is off it.
  if (session.repStatus === 'PENDING' && !session.closeTxHash) return 'PENDING_APPROVAL';
  const position = session.attendees.indexOf(wallet);
  if (position < 0) return 'NOT_LISTED';
  if (session.repStatus === 'PENDING') return 'PENDING_APPROVAL';
  if (session.repStatus === 'CONFIRMED' && position >= session.creditCursor) return 'AWAITING_CREDIT';
  return 'CREDITED';
}

const serializeEvent = (e: RepEvent) => ({
  type: e.type,
  amount: e.amount,
  nominal: e.nominal,
  recognizedAt: e.recognizedAt?.toISOString() ?? null,
  reason: e.reason,
  occurredAt: e.occurredAt.toISOString(),
  txHash: e.txHash,
});

/** A member's current voting power, what is still on the way, and explicit changes. */
export async function buildMemberRep(wallet: string) {
  const walletAddress = wallet.toLowerCase();
  const [snapshot, sessions, events] = await Promise.all([
    getRepSnapshot([walletAddress]).catch((err: Error) => {
      logger.error({ msg: 'Could not read Rep from chain', err: err.message });
      return null;
    }),
    prisma.session.findMany({
      where: {
        registryAddress: currentRegistry(),
        repStatus: { in: ['PENDING', 'CONFIRMED'] },
        attendees: { has: walletAddress },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.repEvent.findMany({
      where: { account: walletAddress },
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: 50,
    }),
  ]);
  const waiting = sessions
    .map((s) => ({
      sessionId: s.sessionIdOnchain,
      name: s.name,
      status: tokenRepStatus(s, walletAddress),
    }))
    .filter((s) => s.status === 'PENDING_APPROVAL' || s.status === 'AWAITING_CREDIT');
  return {
    walletAddress,
    /** 18-decimal string at `asOf`; null if the chain could not be read. */
    rep: snapshot?.balances.get(walletAddress) ?? null,
    totalSupply: snapshot?.totalSupply ?? null,
    asOf: snapshot ? new Date(snapshot.asOf * 1000).toISOString() : null,
    waiting,
    history: events.map(serializeEvent),
  };
}
