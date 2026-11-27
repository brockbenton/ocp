import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';

const OFFICER = '0x1111111111111111111111111111111111111111';
const TARGET = '0x4444444444444444444444444444444444444444';

const chain = vi.hoisted(() => ({
  officers: new Set<string>(),
  rpcDown: false,
  writes: [] as unknown[],
}));

// Every wallet client records its writes, so any on-chain role change would show up.
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createWalletClient: () => ({
    writeContract: async (call: unknown) => {
      chain.writes.push(call);
      return '0xtx';
    },
  }),
}));
vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      return { id: 'did:privy:officer', wallet: { address: '0x1111111111111111111111111111111111111111' } };
    }
  },
}));
vi.mock('../src/services/onchain.service', () => ({
  hasAdminRoleOnChain: async (wallet: string) => {
    if (chain.rpcDown) throw new Error('RPC unavailable');
    return chain.officers.has(wallet.toLowerCase());
  },
  tokenBalanceOnChain: async () => 0n,
}));
vi.mock('../src/lib/queue', () => ({ MINT_QUEUE: 'mint', mintQueue: { add: async () => ({ id: 'test' }) } }));

// The retired key is deliberately configured, as it might still be on a deploy.
const LEGACY_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let app: import('express').Express;
let prisma: typeof import('../src/lib/prisma').default;

beforeAll(async () => {
  vi.stubEnv('DEFAULT_ADMIN_PRIVATE_KEY', LEGACY_KEY);
  app = (await import('../src/app')).createApp();
  prisma = (await import('../src/lib/prisma')).default;
});

beforeEach(async () => {
  chain.officers = new Set([OFFICER]);
  chain.rpcDown = false;
  chain.writes = [];
  await prisma.adminRole.deleteMany({ where: { walletAddress: { in: [OFFICER, TARGET] } } });
});

const auth = { Authorization: 'Bearer test' };
const activeRecords = (walletAddress: string) =>
  prisma.adminRole.count({ where: { walletAddress, revokedAt: null } });

describe('officers cannot change roles, even with the legacy key configured', () => {
  it('has no route to grant a role', async () => {
    const res = await request(app).post('/api/v1/admin/roles').set(auth).send({ walletAddress: TARGET });
    expect(res.status).toBe(404);
    expect(chain.writes).toEqual([]);
    expect(await activeRecords(TARGET)).toBe(0);
  });

  it('has no route to revoke a role', async () => {
    chain.officers.add(TARGET);
    await prisma.adminRole.create({ data: { walletAddress: TARGET, grantedBy: OFFICER } });

    const res = await request(app).delete(`/api/v1/admin/roles/${TARGET}`).set(auth);
    expect(res.status).toBe(404);
    expect(chain.writes).toEqual([]);
    expect(await activeRecords(TARGET)).toBe(1);
  });

  it('does not use the legacy key when publishing metadata', async () => {
    const res = await request(app).post('/api/v1/admin/ipfs/publish').set(auth);
    expect(res.status).toBe(200);
    expect(chain.writes).toEqual([]);
  });

  it('references the legacy key nowhere in the backend source', () => {
    const src = path.resolve(__dirname, '../src');
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /DEFAULT_ADMIN_PRIVATE_KEY|defaultAdmin/.test(readFileSync(path.join(src, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('officer records are reconciled from the chain', () => {
  const list = () => request(app).get('/api/v1/admin/roles').set(auth);
  const wallets = (body: { data: { walletAddress: string }[] }) => body.data.map((r) => r.walletAddress);

  it('records a verified officer who was granted outside the API', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(wallets(res.body)).toContain(OFFICER);
    await list();
    expect(await activeRecords(OFFICER)).toBe(1);
  });

  it('marks a record revoked once the wallet loses the role on-chain', async () => {
    chain.officers.add(TARGET);
    await prisma.adminRole.create({ data: { walletAddress: TARGET, grantedBy: OFFICER } });
    expect(wallets((await list()).body)).toContain(TARGET);

    chain.officers.delete(TARGET);
    expect(wallets((await list()).body)).not.toContain(TARGET);
    expect(await activeRecords(TARGET)).toBe(0);

    // Granted again through an approved path: it comes back as a new record.
    chain.officers.add(TARGET);
    expect(wallets((await list()).body)).toContain(TARGET);
  });

  it('changes nothing when the chain cannot be read', async () => {
    await prisma.adminRole.create({ data: { walletAddress: TARGET, grantedBy: OFFICER } });
    chain.rpcDown = true;
    const res = await list();
    expect(res.status).toBe(503);
    expect(await activeRecords(TARGET)).toBe(1);
  });
});
