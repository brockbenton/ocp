import type { Proposal, Vote } from '@prisma/client';
import { getAddress, recoverTypedDataAddress } from 'viem';
import { addresses } from '../lib/config';
import { chain } from '../lib/contract';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { getProposalOnChain, getVoteContext } from './onchain.service';
import { simulate } from './relay.service';
import { voteCall } from './relayWork.service';

/** OpenZeppelin Governor's `Ballot`, under the Governor's EIP-712 domain. */
export const BALLOT_TYPES = {
  Ballot: [
    { name: 'proposalId', type: 'uint256' },
    { name: 'support', type: 'uint8' },
    { name: 'voter', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const governorDomain = () =>
  ({
    name: 'OCP Club Governor',
    version: '1',
    chainId: chain.id,
    verifyingContract: addresses.governor,
  }) as const;

export class VoteRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function serializeProposal(p: Proposal) {
  return {
    proposalId: p.proposalId,
    proposer: p.proposer,
    targets: p.targets,
    values: p.values,
    calldatas: p.calldatas,
    description: p.description,
    createdAt: p.createdAt.toISOString(),
    voteStart: p.voteStart.toISOString(),
    voteEnd: p.voteEnd.toISOString(),
    queuedEta: p.queuedEta?.toISOString() ?? null,
    executedAt: p.executedAt?.toISOString() ?? null,
    canceledAt: p.canceledAt?.toISOString() ?? null,
    txHash: p.txHash,
  };
}

/** Indexed proposal data with state, tally and quorum read live. */
async function withChainState(p: Proposal) {
  return { ...serializeProposal(p), ...(await getProposalOnChain(p.proposalId)) };
}

const currentGovernor = () => ({ governor: addresses.governor.toLowerCase() });

// The list costs several chain reads per proposal and is public, so it is cached briefly.
const LIST_CACHE_MS = 5_000;
let listCache: { at: number; proposals: Awaited<ReturnType<typeof withChainState>>[] } | null = null;

export async function listProposals() {
  if (listCache && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.proposals;
  const proposals = await prisma.proposal.findMany({
    where: currentGovernor(),
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  listCache = { at: Date.now(), proposals: await Promise.all(proposals.map(withChainState)) };
  return listCache.proposals;
}

export async function getProposal(proposalId: string) {
  const proposal = await prisma.proposal.findFirst({ where: { proposalId, ...currentGovernor() } });
  return proposal ? withChainState(proposal) : null;
}

export async function getVotes(proposalId: string) {
  const votes = await prisma.vote.findMany({
    where: { proposalId, status: { not: 'FAILED' } },
    orderBy: { createdAt: 'asc' },
  });
  return votes.map((v) => ({
    voter: v.voter,
    support: v.support,
    weight: v.weight,
    status: v.status,
    txHash: v.txHash,
  }));
}

const serializeMyVote = (v: Vote) => ({
  proposalId: v.proposalId,
  voter: v.voter,
  support: v.support,
  signature: v.signature,
  status: v.status,
  failureReason: v.failureReason,
  txHash: v.txHash,
});

export async function myVote(proposalId: string, voter: string) {
  const vote = await prisma.vote.findUnique({ where: { proposalId_voter: { proposalId, voter } } });
  return vote ? serializeMyVote(vote) : null;
}

/** Validates a signed vote and queues it for the relay. */
export async function castRelayedVote(input: {
  proposalId: string;
  support: number;
  signature: string;
  voter: string;
}) {
  const { proposalId, support, voter } = input;
  const signature = input.signature as `0x${string}`;
  if (!(await prisma.proposal.findFirst({ where: { proposalId, ...currentGovernor() } }))) {
    throw new VoteRejected(404, 'NOT_FOUND', 'Proposal not found');
  }

  // Ballot nonces are sequential, so one vote per member can be in flight at a time.
  const unsettled = await prisma.vote.findFirst({
    where: { voter, status: { in: ['PENDING', 'SUBMITTED'] } },
  });
  if (unsettled) {
    throw new VoteRejected(409, 'VOTE_PENDING', 'Your previous vote has not landed yet. Try again shortly.');
  }

  const context = await getVoteContext(proposalId, voter);
  if (context.hasVoted) throw new VoteRejected(409, 'ALREADY_VOTED', 'You already voted on this proposal');
  if (context.state !== 'Active') {
    throw new VoteRejected(409, 'VOTING_CLOSED', `Voting is not open (proposal is ${context.state})`);
  }
  if (context.weight === 0n) {
    throw new VoteRejected(403, 'NO_VOTING_POWER', 'You had no Rep when this vote was snapshotted');
  }

  const signer = await recoverTypedDataAddress({
    domain: governorDomain(),
    types: BALLOT_TYPES,
    primaryType: 'Ballot',
    message: { proposalId: BigInt(proposalId), support, voter: getAddress(voter), nonce: context.nonce },
    signature,
  }).catch(() => null);
  if (signer?.toLowerCase() !== voter) {
    throw new VoteRejected(400, 'INVALID_SIGNATURE', 'The signature does not match your wallet and choice');
  }

  const call = voteCall({ proposalId, support, voter, signature });
  try {
    await simulate(call.to, call.data);
  } catch (err) {
    logger.warn({ msg: 'Signed vote failed simulation', proposalId, voter, err: (err as Error).message });
    throw new VoteRejected(400, 'INVALID_VOTE', 'The Governor would reject this vote');
  }

  const queued = {
    support,
    signature,
    weight: context.weight.toString(),
    status: 'PENDING' as const,
    failureReason: null,
    attempts: 0,
    relayTxId: null,
    txHash: null,
  };
  const vote = await prisma.vote.upsert({
    where: { proposalId_voter: { proposalId, voter } },
    create: { proposalId, voter, ...queued },
    update: queued,
  });
  logger.info({ msg: 'Vote queued', proposalId, voter });
  return serializeMyVote(vote);
}
