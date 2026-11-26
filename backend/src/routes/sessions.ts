/**
 * Officers create, close, confirm and reject sessions from their own wallets; the backend
 * only mirrors them and issues QR codes.
 */
import { Router, Request, Response } from 'express';
import type { Session } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { generateQR } from '../services/qr.service';
import { getSignOffOnChain } from '../services/onchain.service';
import { syncSession } from '../services/sessions.service';
import logger from '../lib/logger';
import { findSessionOr404 } from '../lib/session';
import { serializeSession } from '../lib/serialize';

const router = Router();

const SESSION_ID = /^\d{1,78}$/;

const chainUnavailable = (res: Response, err: unknown, sessionId: string) => {
  logger.error({ msg: 'Could not read session from chain', sessionId, err: (err as Error).message });
  res.status(503).json({ error: { code: 'CHAIN_UNAVAILABLE', message: 'Could not read the chain' } });
};

// POST /api/v1/sessions/:sessionId/sync — mirror an officer's transaction right away
// instead of waiting for the indexer.
router.post('/:sessionId/sync', authMiddleware, adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { sessionId } = req.params;
  if (!SESSION_ID.test(sessionId)) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'sessionId must be a numeric string' } });
    return;
  }
  let session: Session | null;
  try {
    session = await syncSession(sessionId, req.user!.walletAddress);
  } catch (err) {
    chainUnavailable(res, err, sessionId);
    return;
  }
  if (!session) {
    res.status(409).json({
      error: { code: 'NOT_ON_CHAIN', message: 'The session is not on the registry yet' },
    });
    return;
  }
  res.json({ data: serializeSession(session) });
});

// GET /api/v1/sessions/:sessionId — get session details (admin only)
router.get('/:sessionId', authMiddleware, adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const session = await findSessionOr404(req.params.sessionId, res);
  if (!session) return;
  res.json({ data: serializeSession(session) });
});

// GET /api/v1/sessions/:sessionId/qr — generate a time-limited signed QR payload (admin only)
router.get('/:sessionId/qr', authMiddleware, adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { sessionId } = req.params;

  const session = await findSessionOr404(sessionId, res);
  if (!session) return;

  if (session.closedAt) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Session is closed' } });
    return;
  }

  // The chain decides: the officer may have closed it moments ago.
  let status: string;
  try {
    status = (await getSignOffOnChain(sessionId)).status;
  } catch (err) {
    chainUnavailable(res, err, sessionId);
    return;
  }
  if (status !== 'NONE') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Session is closed' } });
    return;
  }

  const qr = await generateQR(sessionId);
  res.json({ data: { qr } });
});

export default router;
