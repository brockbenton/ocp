import { randomUUID } from 'node:crypto';
import { verifyTypedData } from 'viem';
import { adminAccount, chain, registryAddress } from '../lib/contract';
import { CHECK_IN_TYPES, checkInDomain } from '../lib/typedData';
import { QREnvelope, QRPayload } from '../types';
import logger from '../lib/logger';

// Owner decision (#72): one QR image is valid for at most 5 minutes.
export const MAX_QR_TTL_MS = 300_000;

/** QR_TTL_MS may shorten the validity window but never lengthen it. */
export function resolveQrTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return MAX_QR_TTL_MS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_QR_TTL_MS) return parsed;
  logger.warn({ msg: 'QR_TTL_MS is invalid or above the maximum, using the maximum', value: raw, maxMs: MAX_QR_TTL_MS });
  return MAX_QR_TTL_MS;
}

const QR_TTL_MS = resolveQrTtlMs(process.env.QR_TTL_MS);

const MAX_UINT256 = 2n ** 256n - 1n;

function typedQR(payload: QRPayload) {
  return {
    domain: checkInDomain(chain.id, registryAddress),
    types: CHECK_IN_TYPES,
    primaryType: 'CheckInQR',
    message: {
      sessionId: BigInt(payload.sessionId),
      issuedAt: BigInt(payload.issuedAt),
      expiresAt: BigInt(payload.expiresAt),
      nonce: payload.nonce,
    },
  } as const;
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) <= MAX_UINT256;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export async function generateQR(sessionId: string): Promise<string> {
  const issuedAt = Date.now();
  const payload: QRPayload = {
    sessionId,
    issuedAt,
    expiresAt: issuedAt + QR_TTL_MS,
    nonce: randomUUID(),
  };

  const signature = await adminAccount.signTypedData(typedQR(payload));

  const envelope: QREnvelope = { payload, signature };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

export async function verifyQR(encoded: string): Promise<QRPayload> {
  let envelope: Partial<QREnvelope> | null;
  try {
    envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<QREnvelope>;
  } catch {
    throw new Error('Malformed QR payload');
  }

  const payload = envelope?.payload;
  const signature = envelope?.signature;

  if (
    !payload ||
    typeof signature !== 'string' ||
    !isSessionId(payload.sessionId) ||
    !isTimestamp(payload.issuedAt) ||
    !isTimestamp(payload.expiresAt) ||
    typeof payload.nonce !== 'string'
  ) {
    throw new Error('Malformed QR payload');
  }

  if (Date.now() > payload.expiresAt) {
    throw new Error('QR code expired');
  }

  // A QR signed for another chain or registry recovers a different signer here.
  const valid = await verifyTypedData({
    ...typedQR(payload),
    address: adminAccount.address,
    signature,
  }).catch(() => false);

  if (!valid) {
    throw new Error('Invalid QR signature');
  }

  return payload;
}
