import type { Session } from '@prisma/client';
import { getAddress } from 'viem';
import { currentRegistry } from '../lib/session';
import { serializeSession } from '../lib/serialize';
import prisma from '../lib/prisma';
import { tokenBalancesOnChain } from './onchain.service';
import { flagsFor, pendingSessions } from './review.service';

const MAX_ATTENDEES = 300;
const DEFAULT_SUGGESTION = 50;
const SUGGESTION_HISTORY = 5;

/** Half as much again as a typical recent meeting, within the contract's cap. */
export async function suggestedMaxAttendees(): Promise<number> {
  const recent = await prisma.session.findMany({
    where: { onchainStatus: 'CONFIRMED', closedAt: { not: null } },
    select: { _count: { select: { checkIns: { where: { mintStatus: 'CONFIRMED' } } } } },
    orderBy: { date: 'desc' },
    take: SUGGESTION_HISTORY,
  });
  const counts = recent.map((s) => s._count.checkIns).sort((a, b) => a - b);
  if (counts.length === 0) return DEFAULT_SUGGESTION;
  const typical = counts[Math.floor(counts.length / 2)];
  return Math.min(MAX_ATTENDEES, Math.max(10, Math.ceil(typical * 1.5)));
}

/**
 * Wallets to close a session with: checked in and holding the token on-chain, strictly
 * increasing as the contract requires. `waiting` check-ins are still being minted.
 */
export async function getAttendeeList(session: Session) {
  const checkIns = await prisma.checkIn.findMany({
    where: { sessionId: session.id },
    select: { mintStatus: true, member: { select: { walletAddress: true } } },
  });
  // One call: officers keep this list open, and it can hold 300 wallets.
  const balances = await tokenBalancesOnChain(
    checkIns.map((c) => c.member.walletAddress),
    session.sessionIdOnchain,
  );
  const holding = checkIns.map((c, i) =>
    balances[i] > 0n ? getAddress(c.member.walletAddress) : null,
  );
  const attendees = holding
    .filter((a) => a !== null)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return {
    sessionId: session.sessionIdOnchain,
    attendees,
    waiting: checkIns.filter((c, i) => holding[i] === null && c.mintStatus !== 'FAILED').length,
    failed: checkIns.filter((c, i) => holding[i] === null && c.mintStatus === 'FAILED').length,
  };
}

export async function getReviewQueue(officer: string) {
  const sessions = (await pendingSessions()).filter((s) => s.registryAddress === currentRegistry());
  return Promise.all(
    sessions.map(async (session) => {
      const members = await prisma.member.findMany({
        where: { walletAddress: { in: session.attendees } },
        select: { walletAddress: true, username: true },
      });
      const names = new Map(members.map((m) => [m.walletAddress, m.username]));
      return {
        ...serializeSession(session),
        attendees: session.attendees.map((wallet) => ({
          walletAddress: wallet,
          username: names.get(wallet) ?? null,
        })),
        flags: await flagsFor(session),
        // The contract rejects a confirmation by the officer who closed the session.
        canConfirm: session.closedBy !== officer,
      };
    }),
  );
}
