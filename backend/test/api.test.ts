import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

// Mutable auth state shared with the hoisted Privy mock (vi.hoisted so it exists
// when the mock factory runs).
const authState = vi.hoisted(() => ({
  wallet: '0x1111111111111111111111111111111111111111' as string,
  throwOnGetUser: false,
}));

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      if (authState.throwOnGetUser) throw new Error('invalid token');
      return {
        id: `did:privy:${authState.wallet}`,
        linkedAccounts: [{ type: 'wallet', walletClientType: 'privy', address: authState.wallet }],
      };
    }
    async getUsers() {
      return [];
    }
  },
}));

const chainState = vi.hoisted(() => ({
  closedOnChain: false,
  closeCalls: 0,
  send: async (): Promise<`0x${string}`> => '0xclose',
}));

vi.mock('../src/services/relay.service', () => ({
  closeSessionOnChain: () => {
    chainState.closeCalls += 1;
    return chainState.send();
  },
}));

// Admin authorization is the on-chain role — mock it so tests don't hit an RPC.
vi.mock('../src/services/onchain.service', () => ({
  hasAdminRoleOnChain: async (wallet: string) =>
    wallet.toLowerCase() === '0x1111111111111111111111111111111111111111',
  tokenBalanceOnChain: async () => 0n,
  isSessionClosedOnChain: async () => chainState.closedOnChain,
}));

// Avoid opening a Redis socket when the app imports the check-in route.
vi.mock('../src/lib/queue', () => ({ MINT_QUEUE: 'mint', mintQueue: { add: async () => ({ id: 'test' }) } }));

import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { generateQR } from '../src/services/qr.service';

const app = createApp();
type Member = Record<string, unknown>;

beforeEach(() => {
  authState.wallet = ALICE;
  authState.throwOnGetUser = false;
});

describe('GET /api/v1/members (public)', () => {
  it('returns the roster with no PII (no linkedAccount, no id, no email)', async () => {
    const res = await request(app).get('/api/v1/members');
    expect(res.status).toBe(200);
    const members = res.body.data.members as Member[];
    expect(members).toHaveLength(6);
    expect(members.every((m) => !('linkedAccount' in m))).toBe(true);
    expect(members.every((m) => !('id' in m))).toBe(true);
    expect(JSON.stringify(members).includes('@')).toBe(false);
  });
});

describe('GET /api/v1/members/:address/{tokens,stats} (public)', () => {
  it('returns the vault for a known member', async () => {
    const res = await request(app).get(`/api/v1/members/${ALICE}/tokens`);
    expect(res.status).toBe(200);
    expect(res.body.data.tokenCount).toBe(16);
  });

  it('returns personal stats for a known member', async () => {
    const res = await request(app).get(`/api/v1/members/${ALICE}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.data.allTimeAttendancePct).toBe(100);
  });

  it('rejects an invalid address with 400', async () => {
    const res = await request(app).get('/api/v1/members/not-an-address/stats');
    expect(res.status).toBe(400);
  });
});

describe('public asset routes', () => {
  it('serves a per-semester badge SVG', async () => {
    const res = await request(app).get('/api/v1/art/Spring%202026');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });

  it('serves a member-tier badge SVG', async () => {
    const res = await request(app).get('/api/v1/badge/official');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });
});

describe('POST /api/v1/check-in', () => {
  it('runs the per-user rate limiter (RateLimit headers present) after auth', async () => {
    const res = await request(app)
      .post('/api/v1/check-in')
      .set('Authorization', 'Bearer test')
      .send({});
    // Body is invalid so the handler 400s, but the limiter ran first and set headers.
    expect(res.status).toBe(400);
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('admin routes are gated by the on-chain role', () => {
  it('401 without a bearer token', async () => {
    const res = await request(app).get('/api/v1/admin/overview');
    expect(res.status).toBe(401);
  });

  it('401 when the token is invalid (Privy verification throws)', async () => {
    authState.throwOnGetUser = true;
    const res = await request(app).get('/api/v1/admin/overview').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });

  it('403 for an authenticated wallet without the on-chain ADMIN_ROLE', async () => {
    authState.wallet = BOB;
    const me = await request(app).get('/api/v1/admin/me').set('Authorization', 'Bearer test');
    expect(me.status).toBe(403);
  });

  it('200 for an on-chain admin on /me and /overview', async () => {
    const me = await request(app).get('/api/v1/admin/me').set('Authorization', 'Bearer test');
    expect(me.status).toBe(200);
    expect(me.body.data.isAdmin).toBe(true);

    const overview = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', 'Bearer test');
    expect(overview.status).toBe(200);
    expect(overview.body.data.totalSessions).toBe(16);
    expect(overview.body.data.series).toHaveLength(16);
  });
});

describe('POST /api/v1/sessions/:sessionId/close', () => {
  const sessionId = '900001';
  const remove = async () => {
    await prisma.checkIn.deleteMany({ where: { session: { sessionIdOnchain: sessionId } } });
    await prisma.session.deleteMany({ where: { sessionIdOnchain: sessionId } });
  };
  const create = () =>
    prisma.session.create({
      data: {
        sessionIdOnchain: sessionId,
        name: 'Close test',
        date: new Date(),
        semester: 'Fall 2026',
        createdBy: ALICE,
        onchainStatus: 'CONFIRMED',
      },
    });
  const addPendingCheckIn = async (id: string, ageMs: number) => {
    const member = await prisma.member.findFirstOrThrow({ where: { walletAddress: ALICE } });
    await prisma.checkIn.create({
      data: { memberId: member.id, sessionId: id, nonce: 'n', checkedInAt: new Date(Date.now() - ageMs) },
    });
  };
  const close = () =>
    request(app).post(`/api/v1/sessions/${sessionId}/close`).set('Authorization', 'Bearer test');
  const stored = () => prisma.session.findUniqueOrThrow({ where: { sessionIdOnchain: sessionId } });

  beforeEach(async () => {
    await remove();
    chainState.closedOnChain = false;
    chainState.closeCalls = 0;
    chainState.send = async () => '0xclose';
  });
  afterEach(remove);

  it('waits for check-ins that are still being recorded', async () => {
    await addPendingCheckIn((await create()).id, 0);
    const res = await close();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MINTS_PENDING');
    expect(chainState.closeCalls).toBe(0);
    expect((await stored()).closedAt).toBeNull();
  });

  it('is not blocked forever by a stuck check-in', async () => {
    await addPendingCheckIn((await create()).id, 60 * 60_000);
    const res = await close();
    expect(res.status).toBe(200);
    expect((await stored()).closeTxHash).toBe('0xclose');
  });

  it('keeps the session open when the chain still shows it active', async () => {
    await create();
    chainState.send = async () => Promise.reject(new Error('timed out'));
    const res = await close();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CHAIN_ERROR');
    expect((await stored()).closedAt).toBeNull();
  });

  it('records the close when an earlier transaction already landed', async () => {
    await create();
    chainState.send = async () => Promise.reject(new Error('SessionNotActive'));
    chainState.closedOnChain = true;
    const res = await close();
    expect(res.status).toBe(200);
    expect((await stored()).closedAt).not.toBeNull();
  });

  it('refuses check-ins and a second close while one is in flight', async () => {
    const session = await create();
    let finish: (hash: `0x${string}`) => void = () => {};
    const sent = new Promise<void>((started) => {
      chainState.send = () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        });
    });
    const first = close().then((res) => res);
    await sent;

    expect((await close()).status).toBe(409);

    const member = privateKeyToAccount(
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    );
    authState.wallet = member.address.toLowerCase();
    const signedAt = Date.now();
    const checkIn = await request(app)
      .post('/api/v1/check-in')
      .set('Authorization', 'Bearer test')
      .send({
        qrPayload: await generateQR(sessionId),
        signedAt,
        memberSignature: await member.signMessage({
          message: `I am checking into session ${sessionId} as ${authState.wallet} at ${signedAt}`,
        }),
      });
    expect(checkIn.status).toBe(409);
    expect(checkIn.body.error.code).toBe('SESSION_CLOSED');
    expect(await prisma.checkIn.count({ where: { sessionId: session.id } })).toBe(0);

    finish('0xclose');
    expect((await first).status).toBe(200);
    expect(chainState.closeCalls).toBe(1);
  });
});
