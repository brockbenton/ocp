import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { checkInDomain, CHECK_IN_TYPES } from '../src/lib/typedData';

// Anvil account #6.
const member = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
const MEMBER = member.address.toLowerCase();
const OTHER = '0x7777777777777777777777777777777777777777';
const SESSION_ID = '9100';

const chain = vi.hoisted(() => ({ paused: false, rpcDown: false }));

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      return {
        id: 'did:privy:limits',
        linkedAccounts: [
          { type: 'wallet', walletClientType: 'privy', address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9' },
        ],
      };
    }
  },
}));
vi.mock('../src/services/onchain.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/onchain.service')>()),
  getPauseState: async () => {
    if (chain.rpcDown) throw new Error('RPC unavailable');
    return { paused: chain.paused, pausedUntil: 0, unpauseApprover: null };
  },
}));

import { createApp } from '../src/app';
import { generateQR } from '../src/services/qr.service';
import { currentRegistry } from '../src/lib/session';
import prisma from '../src/lib/prisma';

const app = createApp();

async function cleanUp() {
  await prisma.checkIn.deleteMany({ where: { session: { sessionIdOnchain: SESSION_ID } } });
  await prisma.session.deleteMany({ where: { sessionIdOnchain: SESSION_ID } });
  await prisma.member.deleteMany({ where: { walletAddress: { in: [MEMBER, OTHER] } } });
}

const newSession = (data: { maxAttendees?: number; repStatus?: 'NONE' | 'PENDING' } = {}) =>
  prisma.session.create({
    data: {
      registryAddress: currentRegistry(),
      sessionIdOnchain: SESSION_ID,
      name: 'Limits',
      date: new Date('2026-11-20T18:00:00Z'),
      semester: 'Fall 2026',
      createdBy: MEMBER,
      onchainStatus: 'CONFIRMED',
      ...data,
    },
  });

async function checkIn() {
  const signedAt = Date.now();
  const memberSignature = await member.signTypedData({
    domain: checkInDomain(84532, currentRegistry() as `0x${string}`),
    types: CHECK_IN_TYPES,
    primaryType: 'CheckIn',
    message: { sessionId: BigInt(SESSION_ID), member: member.address, signedAt: BigInt(signedAt) },
  });
  return request(app)
    .post('/api/v1/check-in')
    .set('Authorization', 'Bearer test')
    .send({ qrPayload: await generateQR(SESSION_ID), memberSignature, signedAt });
}

async function takeASeat(sessionId: string, mintStatus: 'CONFIRMED' | 'FAILED') {
  const other = await prisma.member.create({ data: { walletAddress: OTHER } });
  await prisma.checkIn.create({ data: { memberId: other.id, sessionId, nonce: 'n', mintStatus } });
}

beforeEach(async () => {
  await cleanUp();
  chain.paused = false;
  chain.rpcDown = false;
});
afterAll(cleanUp);

describe('check-in limits', () => {
  it('refuses once the attendee cap is taken', async () => {
    const session = await newSession({ maxAttendees: 1 });
    await takeASeat(session.id, 'CONFIRMED');
    const res = await checkIn();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_FULL');
  });

  it('does not count failed check-ins towards the cap', async () => {
    const session = await newSession({ maxAttendees: 1 });
    await takeASeat(session.id, 'FAILED');
    expect((await checkIn()).status).toBe(202);
  });

  it('refuses a session whose sign-off has started', async () => {
    await newSession({ repStatus: 'PENDING' });
    expect((await checkIn()).body.error.code).toBe('SESSION_CLOSED');
  });

  it('refuses while minting is paused', async () => {
    await newSession();
    chain.paused = true;
    const res = await checkIn();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MINTING_PAUSED');
  });

  it('records the check-in when the pause state cannot be read, for the relay to retry', async () => {
    await newSession();
    chain.rpcDown = true;
    expect((await checkIn()).status).toBe(202);
  });
});
