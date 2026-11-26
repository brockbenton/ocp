/**
 * The second officer's view of closed sessions awaiting approval, with the anomaly flags
 * that should make them look twice. Flags are advice: the chain enforces only the cap and
 * that the confirming officer differs from the closing one.
 */
import type { Session } from '@prisma/client';
import { currentRegistry } from '../lib/session';
import prisma from '../lib/prisma';

export type FlagCode =
  | 'HIGH_ATTENDANCE'
  | 'MANY_FIRST_TIME'
  | 'RECENT_WALLETS'
  | 'UNKNOWN_WALLETS'
  | 'LIST_MISMATCH'
  | 'REPEATED_SESSIONS';

export interface Flag {
  code: FlagCode;
  message: string;
  wallets?: string[];
}

export interface ReviewFacts {
  /** The closed attendee list, lowercase. */
  attendees: string[];
  /** Attendee counts of earlier meetings, newest first. */
  previousCounts: number[];
  /** Attendees with no earlier attendance. */
  firstTimers: string[];
  /** Attendees whose account appeared within 24 hours before the close. */
  recentWallets: string[];
  /** Attendees with no account in the app. */
  unknownWallets: string[];
  /** Wallets the backend recorded as checked in with a minted token. */
  checkedIn: string[];
  /** Other sessions closed in the 24 hours before this one. */
  closedInPreviousDay: number;
}

const TRAILING_WINDOW = 6;
const MIN_HISTORY = 3;
const DAY_MS = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computeFlags(facts: ReviewFacts): Flag[] {
  const flags: Flag[] = [];
  const count = facts.attendees.length;

  const history = facts.previousCounts.slice(0, TRAILING_WINDOW);
  if (history.length >= MIN_HISTORY) {
    const typical = median(history);
    if (count > typical * 1.5 && count >= typical + 5) {
      flags.push({
        code: 'HIGH_ATTENDANCE',
        message: `${count} attendees; recent meetings had a median of ${typical}`,
      });
    }
  }
  if (facts.firstTimers.length >= 3 && facts.firstTimers.length >= count * 0.3) {
    flags.push({
      code: 'MANY_FIRST_TIME',
      message: `${facts.firstTimers.length} of ${count} are attending for the first time`,
      wallets: facts.firstTimers,
    });
  }
  if (facts.recentWallets.length > 0) {
    flags.push({
      code: 'RECENT_WALLETS',
      message: `${facts.recentWallets.length} account(s) were created in the 24 hours before the close`,
      wallets: facts.recentWallets,
    });
  }
  if (facts.unknownWallets.length > 0) {
    flags.push({
      code: 'UNKNOWN_WALLETS',
      message: `${facts.unknownWallets.length} wallet(s) have no account in the app`,
      wallets: facts.unknownWallets,
    });
  }
  const listed = new Set(facts.attendees);
  const checkedIn = new Set(facts.checkedIn);
  const extra = facts.attendees.filter((w) => !checkedIn.has(w));
  const missing = facts.checkedIn.filter((w) => !listed.has(w));
  if (extra.length + missing.length > 0) {
    flags.push({
      code: 'LIST_MISMATCH',
      message:
        `The list differs from recorded check-ins: ${extra.length} listed without one, ` +
        `${missing.length} checked in but left out`,
      wallets: [...extra, ...missing],
    });
  }
  if (facts.closedInPreviousDay >= 2) {
    flags.push({
      code: 'REPEATED_SESSIONS',
      message: `${facts.closedInPreviousDay} other sessions were closed in the preceding 24 hours`,
    });
  }
  return flags;
}

async function gatherFacts(session: Session): Promise<ReviewFacts> {
  const closedAt = session.closedAt ?? new Date();
  const dayBefore = new Date(closedAt.getTime() - DAY_MS);
  const attendees = session.attendees;

  const [earlier, members, checkIns, attendedBefore, closedInPreviousDay] = await Promise.all([
    prisma.session.findMany({
      where: { id: { not: session.id }, closedAt: { lt: closedAt } },
      select: {
        attendees: true,
        _count: { select: { checkIns: { where: { mintStatus: 'CONFIRMED' } } } },
      },
      orderBy: { closedAt: 'desc' },
      take: TRAILING_WINDOW,
    }),
    prisma.member.findMany({
      where: { walletAddress: { in: attendees } },
      select: { walletAddress: true, createdAt: true },
    }),
    prisma.checkIn.findMany({
      where: { sessionId: session.id, mintStatus: 'CONFIRMED' },
      select: { member: { select: { walletAddress: true } } },
    }),
    prisma.checkIn.findMany({
      where: {
        mintStatus: 'CONFIRMED',
        sessionId: { not: session.id },
        checkedInAt: { lt: closedAt },
        member: { walletAddress: { in: attendees } },
      },
      select: { member: { select: { walletAddress: true } } },
    }),
    prisma.session.count({
      where: {
        id: { not: session.id },
        registryAddress: session.registryAddress,
        closedAt: { gte: dayBefore, lte: closedAt },
      },
    }),
  ]);

  const accounts = new Map(members.map((m) => [m.walletAddress, m.createdAt]));
  const returning = new Set(attendedBefore.map((c) => c.member.walletAddress));
  return {
    attendees,
    previousCounts: earlier.map((s) => s.attendees.length || s._count.checkIns),
    firstTimers: attendees.filter((w) => !returning.has(w)),
    recentWallets: attendees.filter((w) => (accounts.get(w)?.getTime() ?? 0) > dayBefore.getTime()),
    unknownWallets: attendees.filter((w) => !accounts.has(w)),
    checkedIn: checkIns.map((c) => c.member.walletAddress),
    closedInPreviousDay,
  };
}

export async function flagsFor(session: Session): Promise<Flag[]> {
  return computeFlags(await gatherFacts(session));
}

/**
 * Sessions awaiting a second officer. Only once the close event is indexed (it carries the
 * attendee list), so nobody reviews, or is alerted about, an incomplete list.
 */
export async function pendingSessions(): Promise<Session[]> {
  return prisma.session.findMany({
    where: { registryAddress: currentRegistry(), repStatus: 'PENDING', closeTxHash: { not: null } },
    orderBy: { closedAt: 'asc' },
  });
}
