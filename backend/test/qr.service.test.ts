import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    async getUser() {
      return {
        id: 'did:privy:member',
        linkedAccounts: [
          { type: 'wallet', walletClientType: 'privy', address: '0x1111111111111111111111111111111111111111' },
        ],
      };
    }
  },
}));
vi.mock('../src/lib/queue', () => ({ MINT_QUEUE: 'mint', mintQueue: { add: async () => ({ id: 'test' }) } }));

import { createApp } from '../src/app';
import { generateQR, verifyQR, resolveQrTtlMs, MAX_QR_TTL_MS } from '../src/services/qr.service';

const START = Date.UTC(2026, 10, 20, 18, 0, 0);

const payloadOf = (qr: string) =>
  (JSON.parse(Buffer.from(qr, 'base64').toString('utf8')) as { payload: { issuedAt: number; expiresAt: number } })
    .payload;

afterEach(() => {
  vi.useRealTimers();
});

describe('QR validity window', () => {
  it('is 5 minutes by default', async () => {
    expect(MAX_QR_TTL_MS).toBe(300_000);
    const { issuedAt, expiresAt } = payloadOf(await generateQR('2001'));
    expect(expiresAt - issuedAt).toBe(300_000);
  });

  it('can be shortened but never lengthened by QR_TTL_MS', () => {
    expect(resolveQrTtlMs(undefined)).toBe(300_000);
    expect(resolveQrTtlMs('')).toBe(300_000);
    expect(resolveQrTtlMs('60000')).toBe(60_000);
    expect(resolveQrTtlMs('600000')).toBe(300_000);
    expect(resolveQrTtlMs('0')).toBe(300_000);
    expect(resolveQrTtlMs('-5')).toBe(300_000);
    expect(resolveQrTtlMs('five minutes')).toBe(300_000);
  });

  it('accepts a code up to its expiry and rejects it afterwards', async () => {
    vi.useFakeTimers({ now: START, toFake: ['Date'] });
    const qr = await generateQR('2001');

    vi.setSystemTime(START + 300_000);
    await expect(verifyQR(qr)).resolves.toMatchObject({ sessionId: '2001' });

    vi.setSystemTime(START + 300_001);
    await expect(verifyQR(qr)).rejects.toThrow('QR code expired');
  });

  it('rejects an expired code at the check-in endpoint', async () => {
    vi.useFakeTimers({ now: START, toFake: ['Date'] });
    const qrPayload = await generateQR('2001');
    vi.setSystemTime(START + 301_000);

    const res = await request(createApp())
      .post('/api/v1/check-in')
      .set('Authorization', 'Bearer test')
      .send({ qrPayload, memberSignature: '0x1234', signedAt: Date.now() });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'INVALID_QR', message: 'QR code expired' });
  });

  it('rejects a code whose expiry was edited', async () => {
    const qr = await generateQR('2001');
    const envelope = JSON.parse(Buffer.from(qr, 'base64').toString('utf8')) as {
      payload: { expiresAt: number };
    };
    envelope.payload.expiresAt += 3_600_000;
    const forged = Buffer.from(JSON.stringify(envelope)).toString('base64');
    await expect(verifyQR(forged)).rejects.toThrow('Invalid QR signature');
  });
});
