import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

const EMBEDDED = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_EMBEDDED = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EXTERNAL = '0xcccccccccccccccccccccccccccccccccccccccc';
const USER_ID = 'did:privy:identity';

const privy = vi.hoisted(() => ({ user: {} as Record<string, unknown> }));

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      return privy.user;
    }
  },
}));
vi.mock('../src/services/onchain.service', () => ({
  hasAdminRoleOnChain: async () => false,
  tokenBalanceOnChain: async () => 0n,
}));
vi.mock('../src/lib/queue', () => ({ MINT_QUEUE: 'mint', mintQueue: { add: async () => ({ id: 'test' }) } }));

import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';

const app = createApp();

const external = { type: 'wallet', chainType: 'ethereum', walletClientType: 'metamask', address: EXTERNAL };
const embedded = (address: string, hdWalletIndex = 0) => ({
  type: 'wallet',
  chainType: 'ethereum',
  walletClientType: 'privy',
  connectorType: 'embedded',
  // Privy returns checksummed addresses.
  address: `0x${address.slice(2).toUpperCase()}`,
  hdWalletIndex,
});

/** A user whose first linked wallet (Privy's `user.wallet`) is an external one. */
function signIn(accounts: object[]) {
  privy.user = { id: USER_ID, wallet: { address: EXTERNAL }, linkedAccounts: accounts };
}

const me = () => request(app).get('/api/v1/members/me').set('Authorization', 'Bearer test');
const save = (bio: string) =>
  request(app).patch('/api/v1/members/me').set('Authorization', 'Bearer test').send({ bio });

const cleanUp = () =>
  prisma.member.deleteMany({ where: { walletAddress: { in: [EMBEDDED, SECOND_EMBEDDED, EXTERNAL] } } });

beforeEach(async () => {
  await cleanUp();
  signIn([external, embedded(EMBEDDED)]);
});
afterAll(cleanUp);

describe('identity is the embedded wallet', () => {
  it('ignores a linked external wallet, even when Privy lists it first', async () => {
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.data.walletAddress).toBe(EMBEDDED);

    await save('hi');
    expect(await prisma.member.findUnique({ where: { privyUserId: USER_ID } })).toMatchObject({
      walletAddress: EMBEDDED,
    });
  });

  it('uses the primary embedded wallet, then stays pinned to the stored one', async () => {
    signIn([embedded(SECOND_EMBEDDED, 1), embedded(EMBEDDED, 0)]);
    expect((await me()).body.data.walletAddress).toBe(EMBEDDED);

    await prisma.member.create({ data: { walletAddress: SECOND_EMBEDDED, privyUserId: USER_ID } });
    expect((await me()).body.data.walletAddress).toBe(SECOND_EMBEDDED);
  });

  it('does not stay pinned to a stored external wallet, and keeps that record', async () => {
    const old = await prisma.member.create({ data: { walletAddress: EXTERNAL, privyUserId: USER_ID } });

    expect((await me()).body.data.walletAddress).toBe(EMBEDDED);
    expect((await save('moved')).status).toBe(200);

    expect(await prisma.member.findUnique({ where: { id: old.id } })).toMatchObject({
      walletAddress: EXTERNAL,
      privyUserId: null,
    });
    expect(await prisma.member.findUnique({ where: { privyUserId: USER_ID } })).toMatchObject({
      walletAddress: EMBEDDED,
    });
  });

  it('rejects an account with only external wallets', async () => {
    signIn([external]);
    const res = await me();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_WALLET');
  });
});
