import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { listOfficers } from '../services/officers.service';
import { buildMemberStats, buildAdminOverview } from '../services/stats.service';
import { publishSemesterMetadata } from '../services/ipfs.service';
import { findSessionOr404 } from '../lib/session';

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
    data: sessions.map((s) => ({
      id: s.id,
      sessionId: s.sessionIdOnchain,
      name: s.name,
      date: s.date.toISOString(),
      semester: s.semester,
      createdBy: s.createdBy,
      txHash: s.txHash,
      closeTxHash: s.closeTxHash,
      onchainStatus: s.onchainStatus,
      closedAt: s.closedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      attendeeCount: s._count.checkIns,
    })),
  });
});

// ── GET /api/v1/admin/sessions/:sessionId/attendees ───────────────────────

router.get('/sessions/:sessionId/attendees', async (req: Request, res: Response): Promise<void> => {
  const { sessionId } = req.params;

  const session = await findSessionOr404(sessionId, res);
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

  const session = await findSessionOr404(sessionId, res);
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

  const rows = [
    csvRow([
      'wallet_address',
      'account',
      'tokens_earned',
      'all_time_pct',
      'semester_pct',
      'status_tier',
      'founding_member',
      'last_seen',
    ]),
    ...members.map((m) =>
      csvRow([
        m.walletAddress,
        m.linkedAccount,
        m.tokensEarned,
        m.allTimeAttendancePct,
        m.currentSemesterAttendancePct,
        m.statusTier,
        m.foundingMember,
        m.lastSeen,
      ]),
    ),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
  res.send(rows.join('\r\n'));
});

// ── GET /api/v1/admin/roles — officers, verified on-chain ─────────────────
// Read-only on purpose: role changes need governance approval (#82), so the API
// has no route that grants or revokes a role.

router.get('/roles', async (req: Request, res: Response): Promise<void> => {
  let officers: Awaited<ReturnType<typeof listOfficers>>;
  try {
    officers = await listOfficers(req.user!.walletAddress);
  } catch (err) {
    logger.error({ msg: 'Officer reconciliation failed', err: (err as Error).message });
    res.status(503).json({ error: { code: 'ROLE_CHECK_FAILED', message: 'Could not verify officer roles' } });
    return;
  }

  res.json({
    data: officers.map((r) => ({
      id: r.id,
      walletAddress: r.walletAddress,
      grantedBy: r.grantedBy,
      grantedAt: r.grantedAt.toISOString(),
      revokedAt: null,
    })),
  });
});

// ── POST /api/v1/admin/ipfs/publish ──────────────────────────────────────
// Generates + stages (and pins, when PINATA_JWT is set) per-semester token
// metadata for every confirmed session. Dry-run without a pinning key.

router.post('/ipfs/publish', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await publishSemesterMetadata();

    // The backend holds no key that can change the registry's base CID (#82), so a
    // newly pinned CID is applied on-chain separately (smart-contract/DEPLOY.md).
    logger.info({ msg: 'IPFS metadata publish requested', staged: result.staged, baseCid: result.baseCid, dryRun: result.dryRun });
    res.json({ data: { ...result, baseCidNeedsOnchainUpdate: result.baseCid !== null } });
  } catch (err) {
    logger.error({ msg: 'IPFS metadata publish failed', err: (err as Error).message });
    res.status(500).json({ error: { code: 'IPFS_ERROR', message: 'Failed to publish metadata' } });
  }
});

export default router;

// ── Shared helpers ────────────────────────────────────────────────────────

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

