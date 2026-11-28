import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { decodeFunctionData, encodeFunctionData, keccak256, toBytes } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProposalPage from '@/app/governance/[proposalId]/page';
import { LANDING_TIMEOUT_MS } from '@/components/features/governance/VotePanel';
import { GOVERNOR_ABI, REGISTRY_ABI } from '@/lib/abi';
import { proposalIdOf } from '@/lib/proposals';
import { api, chain, params, privy, renderWithQuery, OFFICER } from './harness';

const REGISTRY = '0x0000000000000000000000000000000000000001';
const NEW_OFFICER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const SIGNATURE = `0x${'1'.repeat(130)}`;

const actions = {
  targets: [REGISTRY],
  values: ['0'],
  calldatas: [
    encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: 'grantRole',
      args: [keccak256(toBytes('ADMIN_ROLE')), NEW_OFFICER],
    }),
  ],
};
const description = 'Appoint officer C\n\nThey run the Thursday meetings.';
const proposalId = proposalIdOf(actions, description);

const proposal = {
  ...actions,
  proposalId,
  description,
  proposer: OFFICER,
  createdAt: '2026-11-01T00:00:00.000Z',
  queuedEta: null,
  state: 'Active',
  snapshot: 1_790_000_000,
  deadline: 1_790_600_000,
  forVotes: '0',
  againstVotes: '0',
  abstainVotes: '0',
  quorum: '100000000000000000000',
};

let voted = false;

beforeEach(() => {
  voted = false;
  params.proposalId = proposalId;
  api.routes[`GET /governance/proposals/${proposalId}`] = proposal;
  api.routes[`GET /governance/proposals/${proposalId}/my-vote`] = null;
  api.routes['POST /governance/votes'] = { status: 'PENDING' };
  chain.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'hasVoted') return voted;
    if (functionName === 'getVotes') return 25n * 10n ** 18n;
    if (functionName === 'nonces') return 3n;
    throw new Error(`unexpected read ${functionName}`);
  });
});

async function choose(label: 'For' | 'Against' | 'Abstain') {
  const button = await screen.findByRole('button', { name: label });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

describe('voting', () => {
  it('describes the actions from the calldata', async () => {
    renderWithQuery(<ProposalPage />);
    expect(await screen.findByText(`Give ${NEW_OFFICER} the officer role on the registry`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Appoint officer C' })).toBeTruthy();
  });

  it('shows the title and choice before the prompt, and keeps the prompt on', async () => {
    renderWithQuery(<ProposalPage />);
    await choose('Against');
    const confirm = screen.getByRole('group', { name: 'Confirm vote' });
    expect(confirm.textContent).toContain('You are voting AGAINST on Appoint officer C');
    expect(privy.signTypedData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign vote' }));
    await waitFor(() => expect(privy.signTypedData).toHaveBeenCalled());
    const [data, options] = privy.signTypedData.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(data).toMatchObject({
      primaryType: 'Ballot',
      domain: { name: 'OCP Club Governor', verifyingContract: '0x0000000000000000000000000000000000000003' },
      message: { proposalId, support: 0, voter: OFFICER, nonce: '3' },
    });
    expect(options).toMatchObject({
      address: OFFICER,
      uiOptions: {
        showWalletUIs: true,
        title: 'Vote Against',
        description: 'You are voting AGAINST on "Appoint officer C".',
      },
    });
  });

  it('relays the vote and believes it landed only when the chain says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithQuery(<ProposalPage />);
    await choose('For');
    fireEvent.click(screen.getByRole('button', { name: 'Sign vote' }));
    expect(await screen.findByText('Signed For. It is not on-chain yet.')).toBeTruthy();
    await waitFor(() =>
      expect(api.calls.find((c) => c.key === 'POST /governance/votes')?.body).toEqual({
        proposalId,
        support: 1,
        signature: SIGNATURE,
      }),
    );

    voted = true;
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    const status = (await screen.findByRole('status')).textContent;
    // The signature held here may not be the mined one, so no choice is claimed.
    expect(status).toContain('Your vote is on-chain.');
    expect(status).not.toContain('For');
    vi.useRealTimers();
  });

  it('hands the member the signed vote if it has not landed in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithQuery(<ProposalPage />);
    await choose('For');
    fireEvent.click(screen.getByRole('button', { name: 'Sign vote' }));
    await screen.findByText('Signed For. It is not on-chain yet.');
    expect(screen.queryByLabelText('Signed vote')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(LANDING_TIMEOUT_MS + 2_000));
    expect(screen.getByRole('alert').textContent).toContain('Have an officer submit it');
    const payload = JSON.parse((screen.getByLabelText('Signed vote') as HTMLTextAreaElement).value);
    expect(payload).toEqual({ proposalId, voter: OFFICER, support: 1, signature: SIGNATURE });
    vi.useRealTimers();
  });

  it('offers self-submission at once when the relay refuses, and survives a reload', async () => {
    api.failures['POST /governance/votes'] = [503, 'CHAIN_UNAVAILABLE'];
    const first = renderWithQuery(<ProposalPage />);
    await choose('Abstain');
    fireEvent.click(screen.getByRole('button', { name: 'Sign vote' }));
    await screen.findByLabelText('Signed vote');
    first.unmount();

    renderWithQuery(<ProposalPage />);
    expect(await screen.findByText('Signed Abstain. It is not on-chain yet.')).toBeTruthy();
  });

  it('also times out a pending vote first seen from the backend, and can be signed again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.routes[`GET /governance/proposals/${proposalId}/my-vote`] = {
      proposalId,
      voter: OFFICER,
      support: 1,
      signature: SIGNATURE,
      status: 'PENDING',
      failureReason: null,
      txHash: null,
    };
    renderWithQuery(<ProposalPage />);
    await screen.findByText('Signed For. It is not on-chain yet.');
    await act(() => vi.advanceTimersByTimeAsync(LANDING_TIMEOUT_MS + 2_000));
    expect(screen.getByLabelText('Signed vote')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sign again' }));
    expect(await screen.findByRole('button', { name: 'Against' })).toBeTruthy();
    vi.useRealTimers();
  });

  it('lets the member submit the signature from their own wallet', async () => {
    api.failures['POST /governance/votes'] = [503, 'CHAIN_UNAVAILABLE'];
    renderWithQuery(<ProposalPage />);
    await choose('For');
    fireEvent.click(screen.getByRole('button', { name: 'Sign vote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit it myself' }));
    await waitFor(() => expect(privy.sendTransaction).toHaveBeenCalled());
    const tx = privy.sendTransaction.mock.calls[0][0] as { data: `0x${string}` };
    expect(decodeFunctionData({ abi: GOVERNOR_ABI, data: tx.data })).toEqual({
      functionName: 'castVoteBySig',
      args: [BigInt(proposalId), 1, OFFICER, SIGNATURE],
    });
  });

  it('drops a second ballot while an earlier vote is still on its way', async () => {
    api.failures['POST /governance/votes'] = [409, 'VOTE_PENDING'];
    renderWithQuery(<ProposalPage />);
    await choose('Against');
    fireEvent.click(screen.getByRole('button', { name: 'Sign vote' }));

    expect((await screen.findByRole('alert')).textContent).toContain('VOTE_PENDING');
    // Submitting it by hand would cancel the earlier vote, so it is neither offered nor kept.
    expect(screen.queryByLabelText('Signed vote')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit it myself' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Against' })).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
  });

  it('refuses to show a vote button if the server alters the proposal', async () => {
    api.routes[`GET /governance/proposals/${proposalId}`] = {
      ...proposal,
      description: 'Buy pizza',
    };
    renderWithQuery(<ProposalPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("don't match its on-chain id");
    expect(screen.queryByRole('button', { name: 'For' })).toBeNull();
  });

  it('shows quorum as TBD before the snapshot', async () => {
    api.routes[`GET /governance/proposals/${proposalId}`] = { ...proposal, state: 'Pending', quorum: null };
    renderWithQuery(<ProposalPage />);
    expect(await screen.findByText(/Quorum: TBD/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'For' })).toBeNull();
  });

  it('offers no buttons to a member without voting power', async () => {
    chain.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'hasVoted' ? false : 0n,
    );
    renderWithQuery(<ProposalPage />);
    expect(await screen.findByText(/You had no Rep/)).toBeTruthy();
  });
});
