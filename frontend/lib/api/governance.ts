import { Proposal, RelayedVote, SignedVote } from '@/types';
import { apiRequest } from './client';

export async function listProposals(): Promise<Proposal[]> {
  return apiRequest<Proposal[]>('/governance/proposals');
}

export async function getProposal(proposalId: string): Promise<Proposal> {
  return apiRequest<Proposal>(`/governance/proposals/${encodeURIComponent(proposalId)}`);
}

export async function getMyVote(proposalId: string, token: string): Promise<RelayedVote | null> {
  return apiRequest<RelayedVote | null>(
    `/governance/proposals/${encodeURIComponent(proposalId)}/my-vote`,
    { token },
  );
}

/** Asks the relay to submit a signed vote. The voter is the signed-in wallet. */
export async function relayVote(
  vote: Omit<SignedVote, 'voter'>,
  token: string,
): Promise<RelayedVote> {
  return apiRequest<RelayedVote>('/governance/votes', {
    method: 'POST',
    body: JSON.stringify(vote),
    token,
  });
}
