/**
 * EIP-712 definitions for check-in. Every signature is bound to one chain and one
 * registry, so it cannot be replayed on another deployment (#56).
 * `backend/src/lib/typedData.ts` is the copy the server verifies with; keep both identical.
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

/** JSON-RPC signers (eth_signTypedData_v4) need the domain's own type spelled out. */
const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/** What a member signs to check in: this session, their wallet, this chain and registry. */
export function checkInTypedData(
  chainId: number,
  registry: `0x${string}`,
  message: { sessionId: string; member: string; signedAt: number },
) {
  return {
    domain: checkInDomain(chainId, registry),
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, CheckIn: [...CHECK_IN_TYPES.CheckIn] },
    primaryType: 'CheckIn',
    message,
  };
}
