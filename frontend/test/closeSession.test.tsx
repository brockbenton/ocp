import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@privy-io/react-auth', () => ({
  getIdentityToken: async () => 'test-token',
  usePrivy: () => ({ authenticated: true }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/features/admin/CreateSessionForm', () => ({ default: () => null }));

import AdminSessionsPage from '@/app/admin/sessions/page';

const open = {
  id: 'row-1',
  sessionId: '42',
  name: 'Kickoff',
  date: '2026-11-20T18:00:00.000Z',
  semester: 'Fall 2026',
  createdBy: '0x1111111111111111111111111111111111111111',
  txHash: '0xabc',
  closeTxHash: null,
  onchainStatus: 'CONFIRMED',
  closedAt: null as string | null,
  createdAt: '2026-11-20T18:00:00.000Z',
  attendeeCount: 3,
};

let session = { ...open };
let closeResponse: () => Response;
const requests: string[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  session = { ...open };
  requests.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') return closeResponse();
    return json(200, { data: [session] });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminSessionsPage />
    </QueryClientProvider>,
  );
}

async function confirmClose() {
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, close' }));
}

const closeRequests = () => requests.filter((r) => r.startsWith('POST'));

describe('closing a session from /admin/sessions', () => {
  it('asks for confirmation, and cancel sends nothing', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.getByText('Close for good?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(closeRequests()).toEqual([]);
  });

  it('closes the session, then shows it closed with no QR link', async () => {
    closeResponse = () => {
      session = { ...open, closedAt: '2026-11-20T20:00:00.000Z' };
      return json(200, { data: session });
    };
    renderPage();
    expect(await screen.findByRole('link', { name: 'QR' })).toBeTruthy();

    await confirmClose();

    expect(await screen.findByText('Closed')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'QR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(closeRequests()).toEqual(['POST /api/v1/sessions/42/close']);
  });

  it('keeps the session open and explains a chain failure', async () => {
    closeResponse = () =>
      json(500, { error: { code: 'CHAIN_ERROR', message: 'Failed to close session on-chain' } });
    renderPage();
    await confirmClose();

    expect((await screen.findByRole('alert')).textContent).toContain('still shows as open');
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'QR' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('says why when check-ins are still being recorded', async () => {
    const message = 'Check-ins still being recorded on-chain: 2. Try again in a minute.';
    closeResponse = () => json(409, { error: { code: 'MINTS_PENDING', message } });
    renderPage();
    await confirmClose();

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('reloads the list when the request fails after the server closed the session', async () => {
    closeResponse = () => {
      session = { ...open, closedAt: '2026-11-20T19:00:00.000Z' };
      return new Response('<html>Gateway Timeout</html>', { status: 504 });
    };
    renderPage();
    await confirmClose();

    await waitFor(() => expect(screen.getByText('Closed')).toBeTruthy());
  });

  it('reloads the list when the session was already closed', async () => {
    closeResponse = () => {
      session = { ...open, closedAt: '2026-11-20T19:00:00.000Z' };
      return json(409, { error: { code: 'CONFLICT', message: 'Session already closed' } });
    };
    renderPage();
    await confirmClose();

    await waitFor(() => expect(screen.getByText('Closed')).toBeTruthy());
    expect(screen.queryByRole('link', { name: 'QR' })).toBeNull();
  });
});
