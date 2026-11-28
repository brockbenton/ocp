import { getAddress, keccak256, toBytes, zeroHash } from 'viem';
import { publicClient, relayAccount } from '../lib/contract';
import { addresses } from '../lib/config';
import { GOVERNOR_ABI, REGISTRY_ABI, REP_ABI, TIMELOCK_ABI } from '../lib/abi';

export const ADMIN_ROLE = keccak256(toBytes('ADMIN_ROLE'));
export const RELAY_ROLE = keccak256(toBytes('RELAY_ROLE'));
export const MINTER_ROLE = keccak256(toBytes('MINTER_ROLE'));
export const PROPOSER_ROLE = keccak256(toBytes('PROPOSER_ROLE'));
export const CANCELLER_ROLE = keccak256(toBytes('CANCELLER_ROLE'));
export const DEFAULT_ADMIN_ROLE = zeroHash;

const registry = () => ({ address: addresses.registry, abi: REGISTRY_ABI }) as const;
const rep = () => ({ address: addresses.rep, abi: REP_ABI }) as const;
const governor = () => ({ address: addresses.governor, abi: GOVERNOR_ABI }) as const;
const timelock = () => ({ address: addresses.timelock, abi: TIMELOCK_ABI }) as const;

/** `IAttendanceRegistry2.RepStatus`, in contract order. */
export const REP_STATUS = ['NONE', 'PENDING', 'CONFIRMED', 'REJECTED', 'CREDITED'] as const;

// ── Roles ────────────────────────────────────────────────────────────────

/** On-chain source of truth for officer authorization. Read live, never cached. */
export async function hasAdminRoleOnChain(wallet: string): Promise<boolean> {
  return publicClient.readContract({
    ...registry(),
    functionName: 'hasRole',
    args: [ADMIN_ROLE, getAddress(wallet)],
  });
}

export async function hasRelayRole(): Promise<boolean> {
  return publicClient.readContract({
    ...registry(),
    functionName: 'hasRole',
    args: [RELAY_ROLE, relayAccount.address],
  });
}

export async function listOfficers(): Promise<string[]> {
  const officers = await publicClient.readContract({
    ...registry(),
    functionName: 'getRoleMembers',
    args: [ADMIN_ROLE],
  });
  return officers.map((address) => address.toLowerCase());
}

/** Which of the system's roles a wallet holds, as `contract.ROLE` labels. */
export async function rolesHeldBy(wallet: `0x${string}`): Promise<string[]> {
  const checks = [
    { label: 'registry.DEFAULT_ADMIN_ROLE', contract: registry(), role: DEFAULT_ADMIN_ROLE },
    { label: 'registry.ADMIN_ROLE', contract: registry(), role: ADMIN_ROLE },
    { label: 'registry.RELAY_ROLE', contract: registry(), role: RELAY_ROLE },
    { label: 'rep.DEFAULT_ADMIN_ROLE', contract: rep(), role: DEFAULT_ADMIN_ROLE },
    { label: 'rep.MINTER_ROLE', contract: rep(), role: MINTER_ROLE },
    { label: 'timelock.DEFAULT_ADMIN_ROLE', contract: timelock(), role: DEFAULT_ADMIN_ROLE },
    { label: 'timelock.PROPOSER_ROLE', contract: timelock(), role: PROPOSER_ROLE },
    { label: 'timelock.CANCELLER_ROLE', contract: timelock(), role: CANCELLER_ROLE },
  ];
  const held = await Promise.all(
    checks.map(({ contract, role }) =>
      publicClient.readContract({
        address: contract.address,
        abi: REGISTRY_ABI,
        functionName: 'hasRole',
        args: [role, wallet],
      }),
    ),
  );
  return checks.filter((_, i) => held[i]).map((check) => check.label);
}

// ── Registry ─────────────────────────────────────────────────────────────

/** Null when the session does not exist on the registry. */
export async function getSessionOnChain(sessionIdOnchain: string) {
  const session = await publicClient.readContract({
    ...registry(),
    functionName: 'getSession',
    args: [BigInt(sessionIdOnchain)],
  });
  return session.date === 0n ? null : session;
}

export async function getSignOffOnChain(sessionIdOnchain: string) {
  const signOff = await publicClient.readContract({
    ...registry(),
    functionName: 'getSignOff',
    args: [BigInt(sessionIdOnchain)],
  });
  return { ...signOff, status: REP_STATUS[signOff.status] };
}

/** ERC-1155 balance of a member for a session token. */
export async function tokenBalanceOnChain(member: string, sessionIdOnchain: string): Promise<bigint> {
  return publicClient.readContract({
    ...registry(),
    functionName: 'balanceOf',
    args: [getAddress(member), BigInt(sessionIdOnchain)],
  });
}

export async function getPauseState() {
  const [pausedUntil, unpauseApprover, block] = await Promise.all([
    publicClient.readContract({ ...registry(), functionName: 'pausedUntil' }),
    publicClient.readContract({ ...registry(), functionName: 'unpauseApprover' }),
    publicClient.getBlock(),
  ]);
  return {
    paused: pausedUntil > block.timestamp,
    pausedUntil: Number(pausedUntil),
    unpauseApprover: /^0x0{40}$/.test(unpauseApprover) ? null : unpauseApprover.toLowerCase(),
  };
}

// ── Rep ──────────────────────────────────────────────────────────────────

export interface RepSnapshot {
  /** Unix seconds of the block every balance was read at. Rep decays after this. */
  asOf: number;
  totalSupply: string;
  /** Lowercase wallet to 18-decimal Rep. */
  balances: Map<string, string>;
}

/** Current decayed Rep for many wallets, all at one block. */
export async function getRepSnapshot(wallets: string[]): Promise<RepSnapshot> {
  const block = await publicClient.getBlock();
  const at = { blockNumber: block.number };
  const [totalSupply, balances] = await Promise.all([
    publicClient.readContract({ ...rep(), functionName: 'totalSupply', ...at }),
    Promise.all(
      wallets.map((wallet) =>
        publicClient.readContract({
          ...rep(),
          functionName: 'getVotes',
          args: [getAddress(wallet)],
          ...at,
        }),
      ),
    ),
  ]);
  return {
    asOf: Number(block.timestamp),
    totalSupply: totalSupply.toString(),
    balances: new Map(wallets.map((wallet, i) => [wallet.toLowerCase(), balances[i].toString()])),
  };
}

// ── Governance ───────────────────────────────────────────────────────────

/** OpenZeppelin `IGovernor.ProposalState`, in contract order. */
export const PROPOSAL_STATES = [
  'Pending',
  'Active',
  'Canceled',
  'Defeated',
  'Succeeded',
  'Queued',
  'Expired',
  'Executed',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export async function getProposalOnChain(proposalId: string) {
  const id = [BigInt(proposalId)] as const;
  const [state, snapshot, deadline, votes] = await Promise.all([
    publicClient.readContract({ ...governor(), functionName: 'state', args: id }),
    publicClient.readContract({ ...governor(), functionName: 'proposalSnapshot', args: id }),
    publicClient.readContract({ ...governor(), functionName: 'proposalDeadline', args: id }),
    publicClient.readContract({ ...governor(), functionName: 'proposalVotes', args: id }),
  ]);
  const name = PROPOSAL_STATES[state];
  // `quorum(snapshot)` reverts until the snapshot is in the past, and a proposal can be
  // cancelled before then.
  const snapshotPassed =
    name !== 'Pending' &&
    (name !== 'Canceled' || snapshot < (await publicClient.getBlock()).timestamp);
  const quorum = snapshotPassed
    ? await publicClient.readContract({ ...governor(), functionName: 'quorum', args: [snapshot] })
    : null;
  const [againstVotes, forVotes, abstainVotes] = votes;
  return {
    state: name,
    snapshot: Number(snapshot),
    deadline: Number(deadline),
    againstVotes: againstVotes.toString(),
    forVotes: forVotes.toString(),
    abstainVotes: abstainVotes.toString(),
    quorum: quorum?.toString() ?? null,
  };
}

export async function hasVotedOnChain(proposalId: string, voter: string): Promise<boolean> {
  return publicClient.readContract({
    ...governor(),
    functionName: 'hasVoted',
    args: [BigInt(proposalId), getAddress(voter)],
  });
}

export async function getVoteContext(proposalId: string, voter: string) {
  const proposal = await getProposalOnChain(proposalId);
  const account = getAddress(voter);
  const [hasVoted, nonce, weight] = await Promise.all([
    hasVotedOnChain(proposalId, voter),
    publicClient.readContract({ ...governor(), functionName: 'nonces', args: [account] }),
    // No quorum yet means the snapshot, where voting power is read, is not in the past.
    proposal.quorum === null
      ? Promise.resolve(0n)
      : publicClient.readContract({
          ...governor(),
          functionName: 'getVotes',
          args: [account, BigInt(proposal.snapshot)],
        }),
  ]);
  return { state: proposal.state, hasVoted, nonce, weight };
}

/** Guardian status and the bounded governance settings, for the club overview. */
export async function getGovernanceInfo() {
  const read = <T>(value: Promise<T>) => value;
  const [guardian, guardianExpiry, minDelay, importFinalized, threshold, delay, period, numerator] =
    await Promise.all([
      read(publicClient.readContract({ ...timelock(), functionName: 'GUARDIAN' })),
      read(publicClient.readContract({ ...timelock(), functionName: 'GUARDIAN_EXPIRY' })),
      read(publicClient.readContract({ ...timelock(), functionName: 'getMinDelay' })),
      read(publicClient.readContract({ ...rep(), functionName: 'importFinalized' })),
      read(publicClient.readContract({ ...governor(), functionName: 'proposalThreshold' })),
      read(publicClient.readContract({ ...governor(), functionName: 'votingDelay' })),
      read(publicClient.readContract({ ...governor(), functionName: 'votingPeriod' })),
      read(publicClient.readContract({ ...governor(), functionName: 'quorumNumerator', args: [] })),
    ]);
  const guardianActive = await publicClient.readContract({
    ...timelock(),
    functionName: 'hasRole',
    args: [CANCELLER_ROLE, guardian],
  });
  return {
    guardian: { address: guardian.toLowerCase(), active: guardianActive, expiresAt: Number(guardianExpiry) },
    importFinalized,
    proposalThreshold: threshold.toString(),
    votingDelaySeconds: Number(delay),
    votingPeriodSeconds: Number(period),
    quorumNumerator: Number(numerator),
    timelockDelaySeconds: Number(minDelay),
  };
}

export const relayAddress = relayAccount.address;

/** Native (gas) balance of the relay wallet, in wei. */
export async function getRelayBalanceWei(): Promise<bigint> {
  return publicClient.getBalance({ address: relayAccount.address });
}
