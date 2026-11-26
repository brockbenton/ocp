import { randomUUID } from 'node:crypto';
import { verifyMessage } from 'viem';
import { adminAccount } from '../lib/contract';
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

export async function generateQR(sessionId: string): Promise<string> {
  const issuedAt = Date.now();
  const payload: QRPayload = {
    sessionId,
    issuedAt,
    expiresAt: issuedAt + QR_TTL_MS,
    nonce: randomUUID(),
  };

  const message = JSON.stringify(payload);
  const signature = await adminAccount.signMessage({ message });

  const envelope: QREnvelope = { payload, signature };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

export async function verifyQR(encoded: string): Promise<QRPayload> {
  let envelope: QREnvelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as QREnvelope;
  } catch {
    throw new Error('Malformed QR payload');
  }

  const { payload, signature } = envelope;

  if (
    typeof payload.sessionId !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.expiresAt !== 'number' ||
    typeof payload.nonce !== 'string'
  ) {
    throw new Error('Malformed QR payload');
  }

  if (Date.now() > payload.expiresAt) {
    throw new Error('QR code expired');
  }

  const valid = await verifyMessage({
    address: adminAccount.address,
    message: JSON.stringify(payload),
    signature,
  });

  if (!valid) {
    throw new Error('Invalid QR signature');
  }

  return payload;
}
