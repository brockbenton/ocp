/**
 * Proposals and gasless votes. Members create, queue and execute proposals from their own
 * wallets; the backend lists them and pays gas for signed votes. It cannot change a vote:
 * the Governor checks the member's signature, and anyone may submit it.
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import {
  castRelayedVote,
  getProposal,
  getVotes,
  listProposals,
  myVote,
  VoteRejected,
} from '../services/governance.service';
import logger from '../lib/logger';

const router = Router();

const PROPOSAL_ID = /^\d{1,78}$/;

// Each accepted vote costs the relay gas.
const voteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user!.privyUserId,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many votes. Try again in a minute.' } },
});

const chainUnavailable = (res: Response, err: unknown) => {
  logger.error({ msg: 'Could not read governance state', err: (err as Error).message });
  res.status(503).json({ error: { code: 'CHAIN_UNAVAILABLE', message: 'Could not read the chain' } });
};

const notFound = (res: Response) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found' } });

router.get('/proposals', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ data: await listProposals() });
  } catch (err) {
    chainUnavailable(res, err);
  }
});

router.get('/proposals/:proposalId', async (req: Request, res: Response): Promise<void> => {
  const { proposalId } = req.params;
  try {
    const proposal = PROPOSAL_ID.test(proposalId) ? await getProposal(proposalId) : null;
    if (!proposal) {
      notFound(res);
      return;
    }
    res.json({ data: proposal });
  } catch (err) {
    chainUnavailable(res, err);
  }
});

router.get('/proposals/:proposalId/votes', async (req: Request, res: Response): Promise<void> => {
  res.json({ data: await getVotes(req.params.proposalId) });
});

// The caller's own vote, including the signed payload so it can be submitted elsewhere.
router.get('/proposals/:proposalId/my-vote', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  res.json({ data: await myVote(req.params.proposalId, req.user!.walletAddress) });
});

const voteSchema = z.object({
  proposalId: z.string().regex(PROPOSAL_ID),
  support: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'Expected a 65-byte signature'),
});

router.post('/votes', authMiddleware, voteLimiter, validate(voteSchema), async (req: Request, res: Response): Promise<void> => {
  const body = req.body as z.infer<typeof voteSchema>;
  try {
    // The voter is the authenticated wallet, never a client-supplied address.
    const vote = await castRelayedVote({ ...body, voter: req.user!.walletAddress });
    res.status(202).json({ data: vote });
  } catch (err) {
    if (err instanceof VoteRejected) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    chainUnavailable(res, err);
  }
});

export default router;
