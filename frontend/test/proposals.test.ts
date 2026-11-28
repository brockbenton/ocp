import { decodeFunctionData, encodeFunctionData, keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { REGISTRY_ABI } from '@/lib/abi';
import { buildActions, describeActions, matchesProposalId, proposalIdOf } from '@/lib/proposals';
import { formatRep } from '@/lib/rep';
import { parseSignedVote } from '@/lib/votePayload';

const REGISTRY = '0x0000000000000000000000000000000000000001';
const OFFICER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const OTHER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

// Calldata and id computed independently with Foundry's `cast`.
const VECTOR = {
  targets: [REGISTRY],
  values: ['0'],
  calldatas: [
    '0x2f2ff15da49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c217750000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  ],
};
const VECTOR_ID =
  '82344175543637459897215594347007146407963120803913561068342415238788697047300';

describe('proposal integrity', () => {
  it('derives the same id as the Governor', () => {
    expect(proposalIdOf(VECTOR, 'Appoint officer C')).toBe(VECTOR_ID);
  });

  it('hashes a description that looks like hex as text', () => {
    // Computed with `cast` from the bytes of the string "0xbeef".
    expect(proposalIdOf(VECTOR, '0xbeef')).toBe(
      '10972369644580825608509230893668820704871332424963390529074097514458393937801',
    );
  });

  it('detects any change to the text or the actions', () => {
    const proposal = { ...VECTOR, proposalId: VECTOR_ID, description: 'Appoint officer C' };
    expect(matchesProposalId(proposal)).toBe(true);
    expect(matchesProposalId({ ...proposal, description: 'Appoint officer c' })).toBe(false);
    expect(matchesProposalId({ ...proposal, values: ['1'] })).toBe(false);
    expect(matchesProposalId({ ...proposal, targets: [OTHER] })).toBe(false);
    expect(matchesProposalId({ ...proposal, calldatas: ['0x'] })).toBe(false);
    expect(matchesProposalId({ ...proposal, targets: ['nonsense'] })).toBe(false);
  });
});

describe('decoding and templates', () => {
  it('names the Rep minter role, and does not claim to understand an unnamed one', () => {
    const grant = (role: string) =>
      describeActions({
        targets: [REGISTRY],
        values: ['0'],
        calldatas: [
          encodeFunctionData({
            abi: REGISTRY_ABI,
            functionName: 'grantRole',
            args: [keccak256(toBytes(role)), OTHER],
          }),
        ],
      })[0];
    expect(grant('MINTER_ROLE')).toMatchObject({ understood: true });
    expect(grant('MINTER_ROLE').text).toContain('MINTER (can create Rep)');
    expect(grant('SOMETHING_ELSE')).toMatchObject({ understood: false });
  });

  it('grants the new officer before removing the old one', () => {
    const swap = buildActions('swap', { incoming: OFFICER, outgoing: OTHER });
    const calls = swap.calldatas.map((data) =>
      decodeFunctionData({ abi: REGISTRY_ABI, data: data as `0x${string}` }),
    );
    expect(calls.map((c) => c.functionName)).toEqual(['grantRole', 'revokeRole']);
    expect(describeActions(swap).map((a) => a.text)).toEqual([
      `Give ${OFFICER} the officer role on the registry`,
      `Remove the officer role on the registry from ${OTHER}`,
    ]);
  });

  it.each([
    ['grantRep', { account: OFFICER, amount: '12.5', reason: 'hosting' }, `Award 12.5 Rep to ${OFFICER} (reason: hosting)`],
    ['revokeRep', { account: OFFICER, reason: '' }, `Revoke all Rep from ${OFFICER} and block it (reason: none given)`],
    ['parameter', { parameter: 'votingDelay', value: '2' }, 'Set the voting delay to 2 hour(s)'],
    ['parameter', { parameter: 'quorum', value: '15' }, 'Set the quorum to 15% of Rep'],
    ['parameter', { parameter: 'threshold', value: '50' }, 'Set the proposal threshold to 50 Rep'],
    ['parameter', { parameter: 'timelockDelay', value: '3' }, 'Set the Timelock delay to 3 day(s)'],
  ] as const)('builds and describes %s', (template, input, text) => {
    expect(describeActions(buildActions(template, input))).toEqual([{ text, understood: true }]);
  });

  it('marks calls it cannot decode', () => {
    const unknown = describeActions({ targets: [OTHER], values: ['0'], calldatas: ['0xdeadbeef'] });
    expect(unknown[0].understood).toBe(false);
    expect(unknown[0].text).toContain('0xdeadbeef');
    const badData = describeActions({
      targets: [REGISTRY],
      values: ['0'],
      calldatas: ['0xdeadbeef'],
    });
    expect(badData[0].understood).toBe(false);
  });

  it('shows ETH sent with a call', () => {
    const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'pauseMinting' });
    const [action] = describeActions({ targets: [REGISTRY], values: ['1000000000000000000'], calldatas: [data] });
    expect(action.text).toContain('send 1 ETH');
  });

  it('rejects invalid template input', () => {
    expect(() => buildActions('appoint', { incoming: 'bob' })).toThrow('valid wallet');
    expect(() => buildActions('grantRep', { account: OFFICER, amount: '0' })).toThrow('above zero');
    expect(() => buildActions('custom', { target: OTHER, data: '0x12' })).toThrow('hex');
    expect(() => buildActions('parameter', { parameter: '', value: '1' })).toThrow('Choose');
  });
});

describe('formatting and pasted votes', () => {
  it('formats Rep rounded down to two decimals', () => {
    expect(formatRep('29999999999999999999')).toBe('29.99');
    expect(formatRep(10n ** 21n)).toBe('1,000');
    expect(formatRep(null)).toBe('-');
  });

  it('accepts only well-formed signed votes', () => {
    const vote = { proposalId: '1', voter: OFFICER, support: 1, signature: `0x${'a'.repeat(130)}` };
    expect(parseSignedVote(JSON.stringify(vote))).toEqual(vote);
    expect(parseSignedVote(JSON.stringify({ ...vote, support: 3 }))).toBeNull();
    expect(parseSignedVote(JSON.stringify({ ...vote, signature: '0x12' }))).toBeNull();
    expect(parseSignedVote('null')).toBeNull();
    expect(parseSignedVote('{')).toBeNull();
  });
});
