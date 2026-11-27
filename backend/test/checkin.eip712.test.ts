import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
// What the browser signs: accepting these signatures proves both sides agree.
import * as browser from '../../frontend/lib/typedData';
import * as server from '../src/lib/typedData';

// Anvil account #3.
const member = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const MEMBER = member.address.toLowerCase();
const REGISTRY = '0x0000000000000000000000000000000000000001';
const OTHER_REGISTRY = '0x0000000000000000000000000000000000000002';
const BASE_SEPOLIA = 84532;
const SESSION_ID = '9001';

const queued = vi.hoisted(() => [] as unknown[]);

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      return {
        id: 'did:privy:eip712',
        linkedAccounts: [
          { type: 'wallet', walletClientType: 'privy', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' },
        ],
      };
    }
  },
}));
vi.mock('../src/lib/queue', () => ({
  MINT_QUEUE: 'mint',
  mintQueue: {
    add: async (_name: string, data: unknown) => {
      queued.push(data);
      return { id: 'job' };
    },
  },
}));

import { createApp } from '../src/app';
import { generateQR } from '../src/services/qr.service';
import { adoptUnscopedSessions, sessionKey } from '../src/lib/session';
import prisma from '../src/lib/prisma';

const app = createApp();

async function sign(
  overrides: { chainId?: number; registry?: `0x${string}`; sessionId?: string; signer?: typeof member } = {},
  signedAt = Date.now(),
) {
  const request = browser.checkInTypedData(
    overrides.chainId ?? BASE_SEPOLIA,
    overrides.registry ?? REGISTRY,
    { sessionId: overrides.sessionId ?? SESSION_ID, member: MEMBER, signedAt },
  );
  // The wallet receives the request as JSON, so sign exactly what survives that trip.
  const memberSignature = await (overrides.signer ?? member).signTypedData(
    JSON.parse(JSON.stringify(request)) as Parameters<typeof member.signTypedData>[0],
  );
  return { memberSignature, signedAt };
}

const checkIn = (body: object) =>
  request(app).post('/api/v1/check-in').set('Authorization', 'Bearer test').send(body);

/** A QR signed by the same key for a different chain or registry. */
async function qrFromDeployment(env: { CHAIN_ID?: string; CONTRACT_ADDRESS?: string }): Promise<string> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const other = await import('../src/services/qr.service');
  const qr = await other.generateQR(SESSION_ID);
  vi.unstubAllEnvs();
  return qr;
}

async function cleanUp() {
  await prisma.checkIn.deleteMany({ where: { session: { sessionIdOnchain: SESSION_ID } } });
  await prisma.session.deleteMany({ where: { sessionIdOnchain: SESSION_ID } });
  await prisma.member.deleteMany({ where: { walletAddress: MEMBER } });
}

const newSession = (registryAddress: string) =>
  prisma.session.create({
    data: {
      registryAddress,
      sessionIdOnchain: SESSION_ID,
      name: 'Binding',
      date: new Date('2026-11-20T18:00:00Z'),
      semester: 'Fall 2026',
      createdBy: MEMBER,
      onchainStatus: 'CONFIRMED',
    },
  });

beforeAll(async () => {
  await cleanUp();
});
beforeEach(async () => {
  await cleanUp();
  queued.length = 0;
});
afterAll(cleanUp);

describe('check-in signatures are bound to chain and registry', () => {
  it('uses the same definitions in the browser and on the server', () => {
    expect(browser.CHECK_IN_TYPES).toEqual(server.CHECK_IN_TYPES);
    expect(browser.checkInDomain(1, REGISTRY)).toEqual(server.checkInDomain(1, REGISTRY));
  });

  beforeEach(async () => {
    await newSession(REGISTRY);
  });

  it('accepts a signature made with the frontend definitions', async () => {
    const res = await checkIn({ qrPayload: await generateQR(SESSION_ID), ...(await sign()) });
    expect(res.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it.each([
    ['another chain', { CHAIN_ID: '8453' }],
    ['another registry', { CONTRACT_ADDRESS: OTHER_REGISTRY }],
  ])('rejects a QR issued for %s', async (_label, env) => {
    const res = await checkIn({ qrPayload: await qrFromDeployment(env), ...(await sign()) });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'INVALID_QR', message: 'Invalid QR signature' });
    expect(queued).toEqual([]);
  });

  it.each([
    ['another chain', { chainId: 8453 }],
    ['another registry', { registry: OTHER_REGISTRY as `0x${string}` }],
    ['another session', { sessionId: '9002' }],
    [
      'another wallet',
      { signer: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a') },
    ],
  ])('rejects a member signature for %s', async (_label, overrides) => {
    const res = await checkIn({ qrPayload: await generateQR(SESSION_ID), ...(await sign(overrides)) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ADDRESS_MISMATCH');
    expect(queued).toEqual([]);
  });

  it('rejects a plain-message signature of the old format', async () => {
    const signedAt = Date.now();
    const memberSignature = await member.signMessage({
      message: `I am checking into session ${SESSION_ID} as ${MEMBER} at ${signedAt}`,
    });
    const res = await checkIn({ qrPayload: await generateQR(SESSION_ID), memberSignature, signedAt });
    expect(res.status).toBe(400);
  });

  it.each(['abc', '-1', '1.5', String(2n ** 256n)])('rejects a QR whose session id is %s', async (sessionId) => {
    const payload = { sessionId, issuedAt: Date.now(), expiresAt: Date.now() + 1000, nonce: 'n' };
    const qrPayload = Buffer.from(JSON.stringify({ payload, signature: '0x00' })).toString('base64');
    const res = await checkIn({ qrPayload, ...(await sign()) });
    expect(res.body.error).toEqual({ code: 'INVALID_QR', message: 'Malformed QR payload' });
  });
});

describe('sessions are scoped to a registry', () => {
  it('does not find a session that belongs to another registry', async () => {
    await newSession(OTHER_REGISTRY);
    const res = await checkIn({ qrPayload: await generateQR(SESSION_ID), ...(await sign()) });
    expect(res.status).toBe(404);
  });

  it('allows the same on-chain id on two registries but not twice on one', async () => {
    await newSession(OTHER_REGISTRY);
    const here = await newSession(REGISTRY);
    await expect(newSession(REGISTRY)).rejects.toThrow(/Unique constraint/);
    expect(await prisma.session.findUnique({ where: sessionKey(SESSION_ID) })).toMatchObject({ id: here.id });
  });

  it('adopts rows recorded before sessions carried a registry', async () => {
    const legacy = await newSession('');
    expect(await adoptUnscopedSessions()).toBe(1);
    expect(await prisma.session.findUnique({ where: { id: legacy.id } })).toMatchObject({
      registryAddress: REGISTRY,
    });
    expect(await adoptUnscopedSessions()).toBe(0);
  });

  it('never looks a session up by on-chain id alone', () => {
    const src = path.resolve(__dirname, '../src');
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /where:\s*\{\s*sessionIdOnchain/.test(readFileSync(path.join(src, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
