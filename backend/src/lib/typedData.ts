/**
 * EIP-712 definitions for check-in. Every signature is bound to one chain and one
 * registry, so it cannot be replayed on another deployment (#56).
 * `frontend/lib/typedData.ts` must stay identical; a test signs with that copy.
 */
export const CHECK_IN_DOMAIN_NAME = 'OCP Check-In';
export const CHECK_IN_DOMAIN_VERSION = '1';

export function checkInDomain(chainId: number, registry: `0x${string}`) {
  return {
    name: CHECK_IN_DOMAIN_NAME,
    version: CHECK_IN_DOMAIN_VERSION,
    chainId,
    verifyingContract: registry,
  } as const;
}

export const CHECK_IN_TYPES = {
  /** Signed by the QR key and shown on the projector. */
  CheckInQR: [
    { name: 'sessionId', type: 'uint256' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'string' },
  ],
  /** Signed by the member who is checking in. */
  CheckIn: [
    { name: 'sessionId', type: 'uint256' },
    { name: 'member', type: 'address' },
    { name: 'signedAt', type: 'uint64' },
  ],
} as const;
