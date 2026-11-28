/** A signed vote as passed around by hand when the relay hasn't submitted it. */
import { isAddress } from 'viem';
import type { SignedVote } from '@/types';

export const SUPPORT_LABELS = ['Against', 'For', 'Abstain'] as const;

/** Parses a pasted signed vote, or returns null if it isn't a well-formed one. */
export function parseSignedVote(text: string): SignedVote | null {
  try {
    const value = JSON.parse(text) as Partial<SignedVote> | null;
    if (
      !value ||
      typeof value.proposalId !== 'string' ||
      !/^\d{1,78}$/.test(value.proposalId) ||
      typeof value.voter !== 'string' ||
      !isAddress(value.voter, { strict: false }) ||
      (value.support !== 0 && value.support !== 1 && value.support !== 2) ||
      typeof value.signature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(value.signature)
    ) {
      return null;
    }
    const { proposalId, voter, support, signature } = value;
    return { proposalId, voter, support, signature };
  } catch {
    return null;
  }
}
