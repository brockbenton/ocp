import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Router } from 'express';

const OFFICER = '0x1111111111111111111111111111111111111111';

const chain = vi.hoisted(() => ({ isOfficer: true, rpcDown: false, reads: 0 }));

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      return {
        id: 'did:privy:officer',
        linkedAccounts: [
          { type: 'wallet', walletClientType: 'privy', address: '0x1111111111111111111111111111111111111111' },
        ],
      };
    }
    async getUsers() {
      return [];
    }
  },
}));
vi.mock('../src/services/onchain.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/onchain.service')>()),
  hasAdminRoleOnChain: async () => {
    chain.reads += 1;
    if (chain.rpcDown) throw new Error('RPC unavailable');
    return chain.isOfficer;
  },
  tokenBalanceOnChain: async () => 0n,
  getSignOffOnChain: async () => ({ status: 'NONE' }),
  getRepSnapshot: async () => {
    throw new Error('no chain in unit tests');
  },
}));

import { createApp } from '../src/app';
import adminRouter from '../src/routes/admin';
import sessionsRouter from '../src/routes/sessions';

const app = createApp();

type Method = 'get' | 'post' | 'patch' | 'delete';

function routesOf(prefix: string, router: Router): { method: Method; path: string }[] {
  return router.stack.flatMap((layer) =>
    layer.route
      ? Object.keys((layer.route as unknown as { methods: Record<string, boolean> }).methods).map((method) => ({
          method: method as Method,
          path: `${prefix}${layer.route!.path === '/' ? '' : layer.route!.path}`,
        }))
      : [],
  );
}

// Enumerated from the routers, so a new session or admin route is covered automatically.
const SENSITIVE = [
  ...routesOf('/api/v1/sessions', sessionsRouter),
  ...routesOf('/api/v1/admin', adminRouter),
];

const concrete = (path: string) =>
  path
    .replace(':sessionId', '2001')
    .replace(':memberId', 'missing')
    .replace(':walletAddress', OFFICER);

const call = ({ method, path }: { method: Method; path: string }) =>
  request(app)[method](concrete(path)).set('Authorization', 'Bearer test').send({});

beforeEach(() => {
  chain.isOfficer = true;
  chain.rpcDown = false;
  chain.reads = 0;
});

describe('officer access is read from the chain on every sensitive request', () => {
  it('covers the session, QR, export and PII routes', () => {
    const paths = SENSITIVE.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'get /api/v1/sessions/:sessionId/qr',
        'get /api/v1/sessions/:sessionId',
        'post /api/v1/sessions/:sessionId/sync',
        'get /api/v1/admin/review',
        'get /api/v1/admin/sessions/:sessionId/close-list',
        'post /api/v1/admin/metadata/preview',
        'get /api/v1/admin/members',
        'get /api/v1/admin/sessions/:sessionId/attendees',
        'get /api/v1/admin/export/members',
        'get /api/v1/admin/export/sessions/:sessionId',
      ]),
    );
  });

  it.each(SENSITIVE)('$method $path rejects a revoked officer', async (route) => {
    chain.isOfficer = false;
    const res = await call(route);
    expect(res.status).toBe(403);
  });

  it.each(SENSITIVE)('$method $path fails closed when the RPC is down', async (route) => {
    chain.rpcDown = true;
    const res = await call(route);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ROLE_CHECK_FAILED');
  });

  it('applies a revocation to the very next request (no role cache)', async () => {
    const route = { method: 'get' as const, path: '/api/v1/sessions/:sessionId/qr' };
    expect((await call(route)).status).toBe(200);

    chain.isOfficer = false;
    expect((await call(route)).status).toBe(403);

    chain.isOfficer = true;
    expect((await call(route)).status).toBe(200);
    expect(chain.reads).toBe(3);
  });
});
