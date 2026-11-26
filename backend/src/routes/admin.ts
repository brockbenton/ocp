import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { formatUnits, isAddress } from 'viem';
import { validate } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { buildMemberStats, buildAdminOverview } from '../services/stats.service';
import { publishSemesterMetadata } from '../services/ipfs.service';
import { findSessionOr404 } from '../lib/session';
import { serializeSession } from '../lib/serialize';
import { getAttendeeList, getReviewQueue, suggestedMaxAttendees } from '../services/meetings.service';
import { previewSessionMetadata } from '../services/ipfs.service';
import { getRepSnapshotCached } from '../services/rep.service';

const router = Router();

// All admin routes require auth + admin role
router.use(authMiddleware);
router.use(adminMiddleware);

// ── GET /api/v1/admin/me ──────────────────────────────────────────────────
// Lightweight admin-gate probe for the frontend: 200 => admin, 403 => not.

router.get('/me', (req: Request, res: Response): void => {
  res.json({ data: { isAdmin: true, walletAddress: req.user!.walletAddress } });
});

// ── GET /api/v1/admin/overview ────────────────────────────────────────────
// Dashboard overview: attendance-over-time series, per-session headcount, and
// session-over-session (week-over-week) delta.

router.get('/overview', async (_req: Request, res: Response): Promise<void> => {
  const overview = await buildAdminOverview();
  res.json({ data: overview });
});

// ── GET /api/v1/admin/sessions ────────────────────────────────────────────

router.get('/sessions', async (_req: Request, res: Response): Promise<void> => {
  const sessions = await prisma.session.findMany({
    orderBy: { date: 'desc' },
    include: { _count: { select: { checkIns: true } } },
  });

  res.json({
    data: sessions.map((s) => ({ ...serializeSession(s), attendeeCount: s._count.checkIns })),
  });
});

// ── Officer meeting flow ──────────────────────────────────────────────────

// Prefill for "maximum attendees" when starting a meeting.
router.get('/session-defaults', async (_req: Request, res: Response): Promise<void> => {
  res.json({ data: { suggestedMaxAttendees: await suggestedMaxAttendees() } });
});

// The metadata an officer reviews before signing `createSession`.
const previewSchema = z.object({
  sessionId: z.string().regex(/^\d{1,78}$/),
  name: z.string().trim().min(1).max(200),
  date: z.string().datetime(),
});

router.post('/metadata/preview', validate(previewSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ data: await previewSessionMetadata(req.body as z.infer<typeof previewSchema>) });
  } catch (err) {
    logger.error({ msg: 'Metadata preview failed', err: (err as Error).message });
    res.status(502).json({ error: { code: 'IPFS_ERROR', message: 'Could not pin the metadata' } });
  }
});

// The attendee list officer A passes to `closeSession`.
router.get('/sessions/:sessionId/close-list', async (req: Request, res: Response): Promise<void> => {
  const session = await findSessionOr404(req.params.sessionId, res);
  if (!session) return;
  try {
    res.json({ data: await getAttendeeList(session) });
  } catch (err) {
    logger.error({ msg: 'Could not build attendee list', err: (err as Error).message });
    res.status(503).json({ error: { code: 'CHAIN_UNAVAILABLE', message: 'Could not read the chain' } });
  }
});

// Closed sessions waiting for a second officer.
router.get('/review', async (req: Request, res: Response): Promise<void> => {
  res.json({ data: await getReviewQueue(req.user!.walletAddress) });
});

// ── GET /api/v1/admin/sessions/:sessionId/attendees ───────────────────────

router.get('/sessions/:sessionId/attendees', async (req: Request, res: Response): Promise<void> => {
  const { sessionId } = req.params;

  const session = await findSessionOr404(sessionId, res, registryParam(req));
  if (!session) return;

  const checkIns = await prisma.checkIn.findMany({
    where: { sessionId: session.id },
    include: { member: { select: { walletAddress: true } } },
    orderBy: { checkedInAt: 'asc' },
  });

  res.json({
    data: checkIns.map((c) => ({
      walletAddress: c.member.walletAddress,
      checkedInAt: c.checkedInAt.toISOString(),
      mintStatus: c.mintStatus,
      failureReason: c.failureReason,
      txHash: c.txHash,
    })),
  });
});

// ── GET /api/v1/admin/members ─────────────────────────────────────────────

router.get('/members', async (_req: Request, res: Response): Promise<void> => {
  const { members, totalSessions, currentSemester, recentSessions } = await buildMemberStats();

  res.json({ data: { members, totalSessions, currentSemester, recentSessions } });
});

// ── PATCH /api/v1/admin/members/:memberId/founding-member ─────────────────

router.patch(
  '/members/:memberId/founding-member',
  async (req: Request, res: Response): Promise<void> => {
    const { memberId } = req.params;
    const { founding } = req.body as { founding: unknown };

    if (typeof founding !== 'boolean') {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: '`founding` must be a boolean' } });
      return;
    }

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
      return;
    }

    const updated = await prisma.member.update({
      where: { id: memberId },
      data: { foundingMember: founding },
      select: { id: true, walletAddress: true, foundingMember: true },
    });

    logger.info({
      msg: founding ? 'Founding member granted' : 'Founding member revoked',
      memberId: updated.id,
      walletAddress: updated.walletAddress,
    });

    res.json({ data: updated });
  },
);

// ── GET /api/v1/admin/export/sessions/:sessionId ──────────────────────────

router.get('/export/sessions/:sessionId', async (req: Request, res: Response): Promise<void> => {
  const { sessionId } = req.params;

  const session = await findSessionOr404(sessionId, res, registryParam(req));
  if (!session) return;

  const checkIns = await prisma.checkIn.findMany({
    where: { sessionId: session.id },
    include: { member: { select: { walletAddress: true } } },
    orderBy: { checkedInAt: 'asc' },
  });

  const safeName = session.name.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  const filename = `session-${safeName}-attendees.csv`;

  const rows = [
    csvRow(['wallet_address', 'checked_in_at', 'mint_status', 'tx_hash']),
    ...checkIns.map((c) =>
      csvRow([c.member.walletAddress, c.checkedInAt.toISOString(), c.mintStatus, c.txHash]),
    ),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(rows.join('\r\n'));
});

// ── GET /api/v1/admin/export/members ─────────────────────────────────────

router.get('/export/members', async (_req: Request, res: Response): Promise<void> => {
  const { members } = await buildMemberStats();
  const snapshot = await getRepSnapshotCached(members.map((m) => m.walletAddress));
  const asOf = snapshot ? new Date(snapshot.asOf * 1000).toISOString() : null;

  const rows = [
    csvRow([
      'wallet_address',
      'account',
      'tokens_earned',
      'all_time_pct',
      'semester_pct',
      'current_rep',
      'rep_as_of',
      'founding_member',
      'last_seen',
    ]),
    ...members.map((m) => {
      const rep = snapshot?.balances.get(m.walletAddress);
      return csvRow([
        m.walletAddress,
        m.linkedAccount,
        m.tokensEarned,
        m.allTimeAttendancePct,
        m.currentSemesterAttendancePct,
        rep === undefined ? null : formatUnits(BigInt(rep), 18),
        asOf,
        m.foundingMember,
        m.lastSeen,
      ]);
    }),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
  res.send(rows.join('\r\n'));
});

// ── POST /api/v1/admin/ipfs/publish ──────────────────────────────────────
// Generates + stages (and pins, when PINATA_JWT is set) per-semester token
// metadata for every confirmed session. Dry-run without a pinning key.

router.post('/ipfs/publish', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await publishSemesterMetadata();

    // The backend holds no key that can change the registry: an officer applies a newly
    // pinned CID with `setBaseCid` from their own wallet.
    logger.info({ msg: 'IPFS metadata publish requested', staged: result.staged, baseCid: result.baseCid, dryRun: result.dryRun });
    res.json({ data: { ...result, baseCidNeedsOnchainUpdate: result.baseCid !== null } });
  } catch (err) {
    logger.error({ msg: 'IPFS metadata publish failed', err: (err as Error).message });
    res.status(500).json({ error: { code: 'IPFS_ERROR', message: 'Failed to publish metadata' } });
  }
});

export default router;

// ── Shared helpers ────────────────────────────────────────────────────────

/** `?registry=0x…` reads a session recorded on an earlier registry. */
function registryParam(req: Request): string | undefined {
  const { registry } = req.query;
  return typeof registry === 'string' && isAddress(registry, { strict: false }) ? registry : undefined;
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Neutralize spreadsheet formula injection (CWE-1236): a leading =, +, -, @, tab
  // or CR makes Excel/Sheets execute the cell. Prefix with a quote to force text.
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(values: (string | number | boolean | null | undefined)[]): string {
  return values.map(csvEscape).join(',');
}

