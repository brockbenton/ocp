import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = { replace: vi.fn() };
vi.mock('@privy-io/react-auth', () => ({
  getIdentityToken: async () => 'test-token',
  usePrivy: () => ({ ready: true, authenticated: true }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ sessionId: '42' }),
  useRouter: () => router,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
}));

import AdminSessionQRPage from '@/app/admin/sessions/[sessionId]/qr/page';
import { qrTiming } from '@/lib/qrTiming';

const TTL = 300_000;
const START = Date.UTC(2026, 10, 20, 18, 0, 0);

let qrStatus = 200;
/** Offset of the server clock from the projector's clock. */
let serverSkew = 0;
const issued: number[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  qrStatus = 200;
  serverSkew = 0;
  issued.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.endsWith('/qr')) return json(200, { data: { name: 'Kickoff', date: new Date(START).toISOString(), semester: 'Fall 2026' } });
    if (qrStatus !== 200) return json(qrStatus, { error: { code: qrStatus === 409 ? 'CONFLICT' : 'INTERNAL_ERROR', message: 'nope' } });
    issued.push(Date.now());
    const issuedAt = Date.now() + serverSkew;
    const payload = { sessionId: '42', issuedAt, expiresAt: issuedAt + TTL, nonce: String(issued.length) };
    return json(200, { data: { qr: btoa(JSON.stringify({ payload, signature: '0x' })) } });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function renderPage() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <AdminSessionQRPage />
    </QueryClientProvider>,
  );
  await advance(50);
}

/** Whether the code on screen would still be accepted by the server right now. */
function shownQrIsValid(): boolean {
  const shown = screen.queryByTestId('qr')?.textContent;
  if (!shown) return false;
  const { payload } = JSON.parse(atob(shown)) as { payload: { expiresAt: number } };
  return Date.now() + serverSkew <= payload.expiresAt;
}

describe('projector QR page', () => {
  it('replaces the QR 90 s before expiry and never shows an invalid one', async () => {
    await renderPage();
    expect(issued).toHaveLength(1);

    await advance(209_000);
    expect(issued).toHaveLength(1);
    await advance(2_000);
    expect(issued).toHaveLength(2);

    for (let second = 0; second < 900; second += 1) {
      await advance(1_000);
      expect(shownQrIsValid()).toBe(true);
    }
    const gaps = issued.slice(1).map((at, i) => at - issued[i]);
    expect(Math.max(...gaps)).toBeLessThan(TTL);
  });

  it.each([-3_600_000, 3_600_000])('refreshes on time with a server clock offset of %i ms', async (skew) => {
    serverSkew = skew;
    await renderPage();
    for (let second = 0; second < 700; second += 1) {
      await advance(1_000);
      expect(shownQrIsValid()).toBe(true);
    }
    expect(issued.length).toBeGreaterThanOrEqual(3);
    expect(issued.length).toBeLessThanOrEqual(5);
  });

  it('keeps the still-valid QR up while a refresh fails, then recovers', async () => {
    await renderPage();
    const first = screen.getByTestId('qr').textContent;

    qrStatus = 500;
    await advance(230_000);
    expect(screen.getByTestId('qr').textContent).toBe(first);
    expect(screen.getByRole('alert').textContent).toContain('Retrying');

    qrStatus = 200;
    await advance(6_000);
    expect(screen.getByTestId('qr').textContent).not.toBe(first);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('removes an expired QR instead of showing it, and shows a new one once the API returns', async () => {
    await renderPage();
    qrStatus = 500;
    await advance(TTL + 2_000);
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByText(/Failed to load QR code/)).toBeTruthy();

    qrStatus = 200;
    await advance(6_000);
    expect(shownQrIsValid()).toBe(true);
  });

  it('shows the closed state as soon as the API reports it, and stops asking', async () => {
    await renderPage();
    qrStatus = 409;
    await advance(215_000);
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByText(/This session is closed/)).toBeTruthy();

    const calls = vi.fn(globalThis.fetch);
    vi.stubGlobal('fetch', calls);
    await advance(60_000);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('qrTiming', () => {
  const encode = (issuedAt: number, expiresAt: number) => btoa(JSON.stringify({ payload: { issuedAt, expiresAt } }));

  it('refreshes a short-lived code halfway through, not immediately', () => {
    expect(qrTiming(encode(0, 60_000), 1_000)).toEqual({ expiresAt: 61_000, refreshAt: 31_000 });
  });

  it('rejects unreadable payloads', () => {
    expect(qrTiming('not-base64!', 0)).toBeNull();
    expect(qrTiming(encode(10, 10), 0)).toBeNull();
  });
});
