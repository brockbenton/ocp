/** Public facts about the club: contracts, officers, guardian, and every sign-off. */
import { Router, Request, Response } from 'express';
import { addresses, settings } from '../lib/config';
import { chain } from '../lib/contract';
import { currentRegistry } from '../lib/session';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { getGovernanceInfo, getPauseState, listOfficers } from '../services/onchain.service';

const router = Router();

const CACHE_MS = 10_000;
let cache: { at: number; data: unknown } | null = null;

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    res.json({ data: cache.data });
    return;
  }
  try {
    const [officers, pause, governance] = await Promise.all([
      listOfficers(),
      getPauseState(),
      getGovernanceInfo(),
    ]);
    const named = await prisma.member.findMany({
      where: { walletAddress: { in: officers } },
      select: { walletAddress: true, username: true },
    });
    const usernames = new Map(named.map((m) => [m.walletAddress, m.username]));
    const data = {
      chainId: chain.id,
      contracts: {
        registry: addresses.registry,
        rep: addresses.rep,
        governor: addresses.governor,
        timelock: addresses.timelock,
      },
      officers: officers.map((wallet) => ({ walletAddress: wallet, username: usernames.get(wallet) ?? null })),
      pause,
      ...governance,
      openSessionWarnHours: settings.openSessionWarnHours,
    };
    cache = { at: Date.now(), data };
    res.json({ data });
  } catch (err) {
    logger.error({ msg: 'Could not read club state', err: (err as Error).message });
    res.status(503).json({ error: { code: 'CHAIN_UNAVAILABLE', message: 'Could not read the chain' } });
  }
});

// Attendee lists are public on-chain; publishing them here (wallets only) lets any
// member check what officers approved.
router.get('/sessions', async (_req: Request, res: Response): Promise<void> => {
  const sessions = await prisma.session.findMany({
    where: { registryAddress: currentRegistry(), onchainStatus: 'CONFIRMED' },
    orderBy: { date: 'desc' },
    take: 100,
  });
  res.json({
    data: sessions.map((s) => ({
      sessionId: s.sessionIdOnchain,
      name: s.name,
      date: s.date.toISOString(),
      semester: s.semester,
      repStatus: s.repStatus,
      closedAt: s.closedAt?.toISOString() ?? null,
      closedBy: s.closedBy,
      confirmedBy: s.confirmedBy,
      recognizedAt: s.recognizedAt?.toISOString() ?? null,
      attendees: s.attendees,
      creditCursor: s.creditCursor,
      closeTxHash: s.closeTxHash,
    })),
  });
});

export default router;
