import type { TokenRepStatus } from '@/types';

/** How a token's road to voting power reads to its owner; null when there is nothing to add. */
export const TOKEN_REP_LABEL: Record<TokenRepStatus, string | null> = {
  OPEN: 'Meeting still open',
  PENDING_APPROVAL: 'Rep pending officer approval',
  AWAITING_CREDIT: 'Approved, credit processing',
  CREDITED: 'Rep credited',
  REJECTED: 'No Rep: not approved',
  NOT_LISTED: 'No Rep: not on the attendee list',
  LEGACY: null,
};
