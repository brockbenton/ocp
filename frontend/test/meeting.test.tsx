import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BaseError, ContractFunctionRevertedError, decodeFunctionData, getAddress } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import CloseSessionPage from '@/app/admin/sessions/[sessionId]/close/page';
import ReviewPage from '@/app/admin/review/page';
import SessionsPage from '@/app/admin/sessions/page';
import { REGISTRY_ABI } from '@/lib/abi';
import { api, chain, params, privy, renderWithQuery, router, OFFICER } from './harness';

const A = getAddress('0x00000000000000000000000000000000000000aa');
const B = getAddress('0x00000000000000000000000000000000000000bb');

const session = {
  id: 'row-1',
  sessionId: '42',
  name: 'Kickoff',
  date: '2026-11-20T18:00:00.000Z',
  semester: 'Fall 2026',
  createdBy: OFFICER,
  txHash: '0xabc',
  closeTxHash: null,
  onchainStatus: 'CONFIRMED',
  closedAt: null as string | null,
  createdAt: new Date().toISOString(),
  registryAddress: '0x0000000000000000000000000000000000000001',
  isCurrentRegistry: true,
  maxAttendees: 40,
  metadataCid: null,
  repStatus: 'NONE',
  closedBy: null as string | null,
  confirmedBy: null,
  recognizedAt: null,
  listedCount: 0,
  creditCursor: 0,
  attendeeCount: 2,
};

/** The contract calls the officer's wallet was asked to send. */
const sent = () =>
  privy.sendTransaction.mock.calls.map(([tx]) =>
    decodeFunctionData({ abi: REGISTRY_ABI, data: (tx as { data: `0x${string}` }).data }),
  );

const revert = (errorName: string) => {
  const cause = new ContractFunctionRevertedError({ abi: [], functionName: 'x' });
  Object.assign(cause, { data: { errorName } });
  return new BaseError('reverted', { cause });
};

describe('starting a meeting', () => {
  beforeEach(() => {
    api.routes['GET /admin/sessions'] = [];
    api.routes['GET /admin/session-defaults'] = { suggestedMaxAttendees: 45 };
    api.routes['POST /admin/metadata/preview'] = {
      metadata: {
        name: 'OCP — November 20, 2026',
        description: 'Attendance token for "Kickoff".',
        image: 'ipfs://art',
        attributes: [{ trait_type: 'Meeting #', value: 3 }],
      },
      cid: 'bafyPreviewCid',
    };
  });

  async function review() {
    renderWithQuery(<SessionsPage />);
    const cap = await screen.findByLabelText('Maximum attendees');
    await waitFor(() => expect((cap as HTMLInputElement).value).toBe('45'));
    fireEvent.change(screen.getByLabelText('Meeting name'), { target: { value: 'Kickoff' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByTestId('metadata-cid');
  }

  it('shows the metadata and CID before anything is signed', async () => {
    await review();
    expect(screen.getByTestId('metadata-cid').textContent).toBe('bafyPreviewCid');
    expect(screen.getByText('Attendance token for "Kickoff".')).toBeTruthy();
    expect(privy.sendTransaction).not.toHaveBeenCalled();
  });

  it('signs createSession with the reviewed cap and CID, then opens the QR', async () => {
    await review();
    api.routes['GET /admin/sessions'] = [];
    // The sync call's path carries the generated id.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) =>
      String(url).endsWith('/sync')
        ? new Response(JSON.stringify({ data: session }), { status: 200 })
        : originalFetch(url, init);

    fireEvent.click(screen.getByRole('button', { name: 'Sign and start' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/\/admin\/sessions\/\d+\/qr/)));

    const [call] = sent();
    expect(call.functionName).toBe('createSession');
    expect(call.args?.slice(2)).toEqual(['Kickoff', 'Fall 2026', 45, 'bafyPreviewCid']);
    expect(privy.sendTransaction.mock.calls[0][1]).toMatchObject({
      address: OFFICER,
      uiOptions: { showWalletUIs: true },
    });
  });
});

describe('ending a meeting', () => {
  beforeEach(() => {
    params.sessionId = '42';
    api.routes['GET /sessions/42'] = session;
    api.routes['POST /sessions/42/sync'] = session;
    api.routes['GET /admin/sessions/42/close-list'] = { sessionId: '42', attendees: [A, B], waiting: 0, failed: 0 };
  });

  const confirmClose = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'End meeting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, sign and close' }));
  };

  it('asks for confirmation, and cancel sends nothing', async () => {
    renderWithQuery(<CloseSessionPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'End meeting' }));
    expect(screen.getByText('Close for good?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(privy.sendTransaction).not.toHaveBeenCalled();
  });

  it('shows the list, signs closeSession with exactly that list, and returns to sessions', async () => {
    renderWithQuery(<CloseSessionPage />);
    expect(await screen.findByText(A)).toBeTruthy();
    await confirmClose();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/sessions'));
    expect(sent()).toEqual([{ functionName: 'closeSession', args: [42n, [A, B]] }]);
    expect(api.calls.map((c) => c.key)).toContain('POST /sessions/42/sync');
  });

  it('does not report a failure when only the mirror lags behind a successful close', async () => {
    api.failures['POST /sessions/42/sync'] = [503, 'CHAIN_UNAVAILABLE'];
    renderWithQuery(<CloseSessionPage />);
    await confirmClose();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/sessions'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains a failure and leaves the session open', async () => {
    chain.simulateContract.mockRejectedValue(revert('NotAttendee'));
    renderWithQuery(<CloseSessionPage />);
    await confirmClose();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('does not hold this session');
    expect(alert.textContent).toContain('still open');
    expect(privy.sendTransaction).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('warns about check-ins still being minted', async () => {
    api.routes['GET /admin/sessions/42/close-list'] = { sessionId: '42', attendees: [A], waiting: 2, failed: 1 };
    renderWithQuery(<CloseSessionPage />);
    expect((await screen.findByRole('status')).textContent).toContain('2 check-in(s) are still being minted');
    expect(screen.getByText(/1 check-in\(s\) failed/)).toBeTruthy();
  });

  it('offers no close action for a closed session', async () => {
    api.routes['GET /sessions/42'] = { ...session, closedAt: '2026-11-20T20:00:00.000Z' };
    renderWithQuery(<CloseSessionPage />);
    expect(await screen.findByText('This session is already closed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End meeting' })).toBeNull();
  });
});

describe('the sessions list', () => {
  beforeEach(() => {
    api.routes['GET /admin/session-defaults'] = { suggestedMaxAttendees: 45 };
    api.routes['GET /club'] = {
      officers: [],
      pause: { paused: false, pausedUntil: 0, unpauseApprover: null },
      guardian: { active: false },
      openSessionWarnHours: 6,
    };
  });

  it('offers to end open meetings and warns about stale ones, but not closed ones', async () => {
    api.routes['GET /admin/sessions'] = [
      { ...session, createdAt: new Date(Date.now() - 7 * 3_600_000).toISOString() },
      { ...session, id: 'row-2', sessionId: '43', name: 'Done', closedAt: '2026-11-19T20:00:00.000Z', repStatus: 'PENDING' },
      { ...session, id: 'row-3', sessionId: '44', name: 'Old registry', isCurrentRegistry: false },
    ];
    renderWithQuery(<SessionsPage />);
    const open = await screen.findByRole('region', { name: 'Open sessions' });
    expect(within(open).getByText('Still open, close it?')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'End meeting' }).map((a) => a.getAttribute('href'));
    expect(new Set(links)).toEqual(new Set(['/admin/sessions/42/close']));
    expect(screen.getByText('Rep pending approval')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'QR' })).toHaveLength(1);
  });
});

describe('second-officer review', () => {
  const item = {
    ...session,
    closedAt: '2026-11-20T20:00:00.000Z',
    repStatus: 'PENDING',
    closedBy: B.toLowerCase(),
    attendees: [{ walletAddress: A, username: 'alice' }],
    flags: [{ code: 'RECENT_WALLETS', message: '1 account(s) were created in the 24 hours before the close', wallets: [A] }],
    canConfirm: true,
  };

  it('shows the list and warnings, and signs the approval', async () => {
    api.routes['GET /admin/review'] = [item];
    api.routes['POST /sessions/42/sync'] = session;
    renderWithQuery(<ReviewPage />);
    expect((await screen.findByRole('list', { name: 'Warnings' })).textContent).toContain('24 hours');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent()).toEqual([{ functionName: 'confirmSessionRep', args: [42n] }]));
  });

  it('lets the closer reject but not approve', async () => {
    api.routes['GET /admin/review'] = [{ ...item, canConfirm: false }];
    renderWithQuery(<ReviewPage />);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/another officer has to approve it/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
