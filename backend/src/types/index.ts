export interface AuthUser {
  privyUserId: string;
  walletAddress: string; // lowercase, the user's Privy embedded wallet (see identity.service)
}

export interface QRPayload {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface QREnvelope {
  payload: QRPayload;
  signature: `0x${string}`;
}
