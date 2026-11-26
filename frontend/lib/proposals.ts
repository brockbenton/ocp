/**
 * Turns a proposal into words, from its on-chain calldata. Nothing here trusts the
 * backend's description of what a proposal does: the actions are decoded in the browser,
 * and the whole proposal is checked against the id the member is asked to sign.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseUnits,
  toBytes,
  type Abi,
} from 'viem';
import { GOVERNOR_ABI, REGISTRY_ABI, REP_ABI, TIMELOCK_ABI } from '@/lib/abi';
import { CONTRACT_ADDRESS, GOVERNOR_ADDRESS, REP_ADDRESS, TIMELOCK_ADDRESS } from '@/lib/constants';

export interface ProposalActions {
  targets: string[];
  /** Wei, as decimal strings. */
  values: string[];
  calldatas: string[];
}

export const descriptionHash = (description: string) => keccak256(toBytes(description));

/** The id the Governor derives from a proposal's contents. */
export function proposalIdOf(actions: ProposalActions, description: string): string {
  const encoded = encodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'bytes[]' }, { type: 'bytes32' }],
    [
      actions.targets.map((t) => getAddress(t)),
      actions.values.map(BigInt),
      actions.calldatas as `0x${string}`[],
      descriptionHash(description),
    ],
  );
  return BigInt(keccak256(encoded)).toString();
}

/** True only if the text and actions shown are exactly what the id commits to. */
export function matchesProposalId(
  proposal: ProposalActions & { proposalId: string; description: string },
): boolean {
  try {
    return proposalIdOf(proposal, proposal.description) === proposal.proposalId;
  } catch {
    return false;
  }
}

export const proposalTitle = (description: string) =>
  description.split('\n')[0].trim() || 'Untitled proposal';

export const proposalBody = (description: string) =>
  description.split('\n').slice(1).join('\n').trim();

// ── Decoding ─────────────────────────────────────────────────────────────

const ROLE_NAMES: Record<string, string> = {
  [keccak256(toBytes('ADMIN_ROLE'))]: 'officer',
  [keccak256(toBytes('RELAY_ROLE'))]: 'relay',
  [`0x${'0'.repeat(64)}`]: 'DEFAULT ADMIN',
  [keccak256(toBytes('PROPOSER_ROLE'))]: 'PROPOSER',
  [keccak256(toBytes('CANCELLER_ROLE'))]: 'CANCELLER',
  [keccak256(toBytes('EXECUTOR_ROLE'))]: 'EXECUTOR',
};

const contracts = () => [
  { label: 'registry', address: CONTRACT_ADDRESS, abi: REGISTRY_ABI as Abi },
  { label: 'Rep', address: REP_ADDRESS, abi: REP_ABI as Abi },
  { label: 'Governor', address: GOVERNOR_ADDRESS, abi: GOVERNOR_ABI as Abi },
  { label: 'Timelock', address: TIMELOCK_ADDRESS, abi: TIMELOCK_ABI as Abi },
];

export interface DescribedAction {
  text: string;
  /** False if the action could not be decoded; the raw data is shown instead. */
  understood: boolean;
}

const rep = (amount: unknown) => `${formatUnits(amount as bigint, 18)} Rep`;
const days = (seconds: unknown) => {
  const s = Number(seconds);
  return s % 86_400 === 0 ? `${s / 86_400} day(s)` : `${s / 3_600} hour(s)`;
};

const SENTENCES: Record<string, (args: readonly unknown[], label: string) => string> = {
  grantRole: ([role, who], label) => `Give ${who} the ${ROLE_NAMES[role as string] ?? role} role on the ${label}`,
  revokeRole: ([role, who], label) =>
    `Remove the ${ROLE_NAMES[role as string] ?? role} role on the ${label} from ${who}`,
  grant: ([to, amount, reason]) => `Award ${rep(amount)} to ${to} (reason: ${reason || 'none given'})`,
  revoke: ([who, reason]) => `Revoke all Rep from ${who} and block it (reason: ${reason || 'none given'})`,
  unblock: ([who]) => `Let ${who} earn Rep again`,
  setVotingDelay: ([s]) => `Set the voting delay to ${days(s)}`,
  setVotingPeriod: ([s]) => `Set the voting period to ${days(s)}`,
  setProposalThreshold: ([amount]) => `Set the proposal threshold to ${rep(amount)}`,
  updateQuorumNumerator: ([n]) => `Set the quorum to ${n}% of Rep`,
  updateDelay: ([s]) => `Set the Timelock delay to ${days(s)}`,
  rejectSessionRep: ([id]) => `Reject the Rep for session ${id}`,
  confirmSessionRep: ([id]) => `Approve the Rep for session ${id}`,
  unpauseMinting: () => 'Resume token minting',
};

export function describeActions({ targets, values, calldatas }: ProposalActions): DescribedAction[] {
  return targets.map((target, i) => {
    const data = calldatas[i] as `0x${string}`;
    const value = BigInt(values[i] ?? '0');
    const suffix = value > 0n ? ` and send ${formatUnits(value, 18)} ETH` : '';
    const contract = contracts().find((c) => c.address?.toLowerCase() === target.toLowerCase());
    if (contract) {
      try {
        const { functionName, args = [] } = decodeFunctionData({ abi: contract.abi, data });
        const sentence = SENTENCES[functionName];
        const text = sentence
          ? sentence(args, contract.label)
          : `Call ${functionName}(${args.map(String).join(', ')}) on the ${contract.label}`;
        return { text: text + suffix, understood: true };
      } catch {
        // Falls through to the raw form.
      }
    }
    return { text: `Unrecognized call to ${target}: ${data}${suffix}`, understood: false };
  });
}

// ── Templates ────────────────────────────────────────────────────────────

export type TemplateKey =
  | 'appoint'
  | 'swap'
  | 'remove'
  | 'grantRep'
  | 'revokeRep'
  | 'rotateRelay'
  | 'parameter'
  | 'custom';

export interface TemplateField {
  name: string;
  label: string;
  kind: 'address' | 'rep' | 'text' | 'parameter' | 'number' | 'hex';
}

export const PARAMETERS = {
  votingDelay: { label: 'Voting delay (hours, 1 to 168)', fn: 'setVotingDelay', target: 'governor', scale: 3600n },
  votingPeriod: { label: 'Voting period (days, 3 to 14)', fn: 'setVotingPeriod', target: 'governor', scale: 86400n },
  threshold: { label: 'Proposal threshold (Rep, 10 to 1000)', fn: 'setProposalThreshold', target: 'governor', scale: 10n ** 18n },
  quorum: { label: 'Quorum (percent, 5 to 30)', fn: 'updateQuorumNumerator', target: 'governor', scale: 1n },
  timelockDelay: { label: 'Timelock delay (days, 1 to 7)', fn: 'updateDelay', target: 'timelock', scale: 86400n },
} as const;

export const TEMPLATES: Record<TemplateKey, { label: string; fields: TemplateField[] }> = {
  appoint: { label: 'Appoint an officer', fields: [{ name: 'incoming', label: 'New officer wallet', kind: 'address' }] },
  swap: {
    label: 'Replace an officer',
    fields: [
      { name: 'incoming', label: 'New officer wallet', kind: 'address' },
      { name: 'outgoing', label: 'Officer to remove', kind: 'address' },
    ],
  },
  remove: { label: 'Remove an officer', fields: [{ name: 'outgoing', label: 'Officer to remove', kind: 'address' }] },
  grantRep: {
    label: 'Award Rep',
    fields: [
      { name: 'account', label: 'Member wallet', kind: 'address' },
      { name: 'amount', label: 'Rep', kind: 'rep' },
      { name: 'reason', label: 'Reason (text or URI)', kind: 'text' },
    ],
  },
  revokeRep: {
    label: 'Revoke Rep',
    fields: [
      { name: 'account', label: 'Member wallet', kind: 'address' },
      { name: 'reason', label: 'Reason (text or URI)', kind: 'text' },
    ],
  },
  rotateRelay: {
    label: 'Rotate the relay wallet',
    fields: [
      { name: 'outgoing', label: 'Current relay wallet', kind: 'address' },
      { name: 'incoming', label: 'New relay wallet', kind: 'address' },
    ],
  },
  parameter: {
    label: 'Change a governance setting',
    fields: [
      { name: 'parameter', label: 'Setting', kind: 'parameter' },
      { name: 'value', label: 'New value', kind: 'number' },
    ],
  },
  custom: {
    label: 'Custom call',
    fields: [
      { name: 'target', label: 'Contract address', kind: 'address' },
      { name: 'data', label: 'Calldata (0x…)', kind: 'hex' },
    ],
  },
};

/** Builds the calls for a template. Throws a readable message on invalid input. */
export function buildActions(template: TemplateKey, input: Record<string, string>): ProposalActions {
  const address = (name: string) => {
    const value = (input[name] ?? '').trim();
    if (!isAddress(value)) throw new Error('Enter a valid wallet address.');
    return getAddress(value);
  };
  const role = (name: 'ADMIN_ROLE' | 'RELAY_ROLE') => keccak256(toBytes(name));
  const roleCall = (fn: 'grantRole' | 'revokeRole', name: 'ADMIN_ROLE' | 'RELAY_ROLE', who: `0x${string}`) => ({
    target: CONTRACT_ADDRESS,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: fn, args: [role(name), who] }),
  });

  let calls: { target: `0x${string}`; data: `0x${string}` }[];
  switch (template) {
    case 'appoint':
      calls = [roleCall('grantRole', 'ADMIN_ROLE', address('incoming'))];
      break;
    case 'swap':
      // Grant first: the registry never allows fewer than two officers.
      calls = [
        roleCall('grantRole', 'ADMIN_ROLE', address('incoming')),
        roleCall('revokeRole', 'ADMIN_ROLE', address('outgoing')),
      ];
      break;
    case 'remove':
      calls = [roleCall('revokeRole', 'ADMIN_ROLE', address('outgoing'))];
      break;
    case 'rotateRelay':
      calls = [
        roleCall('revokeRole', 'RELAY_ROLE', address('outgoing')),
        roleCall('grantRole', 'RELAY_ROLE', address('incoming')),
      ];
      break;
    case 'grantRep': {
      if (!/^\d+(\.\d{1,18})?$/.test(input.amount ?? '') || parseUnits(input.amount, 18) === 0n) {
        throw new Error('Enter a Rep amount above zero.');
      }
      calls = [
        {
          target: REP_ADDRESS,
          data: encodeFunctionData({
            abi: REP_ABI,
            functionName: 'grant',
            args: [address('account'), parseUnits(input.amount, 18), input.reason ?? ''],
          }),
        },
      ];
      break;
    }
    case 'revokeRep':
      calls = [
        {
          target: REP_ADDRESS,
          data: encodeFunctionData({
            abi: REP_ABI,
            functionName: 'revoke',
            args: [address('account'), input.reason ?? ''],
          }),
        },
      ];
      break;
    case 'parameter': {
      const parameter = PARAMETERS[input.parameter as keyof typeof PARAMETERS];
      if (!parameter) throw new Error('Choose a setting.');
      if (!/^\d+$/.test(input.value ?? '')) throw new Error('Enter a whole number.');
      const isTimelock = parameter.target === 'timelock';
      calls = [
        {
          target: isTimelock ? TIMELOCK_ADDRESS : GOVERNOR_ADDRESS,
          data: encodeFunctionData({
            abi: (isTimelock ? TIMELOCK_ABI : GOVERNOR_ABI) as Abi,
            functionName: parameter.fn,
            args: [BigInt(input.value) * parameter.scale],
          }),
        },
      ];
      break;
    }
    case 'custom': {
      const data = (input.data ?? '').trim();
      if (!isHex(data) || data.length < 10 || data.length % 2 !== 0) {
        throw new Error('Enter the calldata as hex, starting with 0x.');
      }
      calls = [{ target: address('target'), data }];
      break;
    }
  }
  return {
    targets: calls.map((c) => c.target),
    values: calls.map(() => '0'),
    calldatas: calls.map((c) => c.data),
  };
}
