/** Shared fakes: Privy, the router, the backend API and the chain. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';

export const OFFICER = '0x1111111111111111111111111111111111111111';

export const privy = {
  authenticated: true,
  sendTransaction: vi.fn(),
  signTypedData: vi.fn(),
};

export const router = { push: vi.fn(), replace: vi.fn() };
export const params: Record<string, string> = {};

export const chain = {
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
  getBalance: vi.fn(),
};

export interface Api {
  /** `METHOD /path` → response body's `data`, or a [status, errorCode] pair. */
  routes: Record<string, unknown>;
  failures: Record<string, [number, string]>;
  calls: { key: string; body: unknown }[];
}

export const api: Api = { routes: {}, failures: {}, calls: [] };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Newer Node versions define their own `localStorage` global that shadows jsdom's, so
// the tests bring one that behaves the same everywhere.
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

export function resetFakes(): void {
  privy.authenticated = true;
  privy.sendTransaction = vi.fn(async () => ({ hash: '0xhash' }));
  privy.signTypedData = vi.fn(async () => ({ signature: `0x${'1'.repeat(130)}` }));
  router.push.mockReset();
  chain.simulateContract.mockReset().mockResolvedValue({});
  chain.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success' });
  chain.readContract.mockReset();
  chain.getBalance.mockReset().mockResolvedValue(10n ** 16n);
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  api.routes = {
    'GET /members/me': { walletAddress: OFFICER, username: 'officer', avatarColor: 0, bio: null, notifyEmail: false },
  };
  api.failures = {};
  api.calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/^.*\/api\/v1/, '')}`;
    api.calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (api.failures[key]) {
      const [status, code] = api.failures[key];
      return json(status, { error: { code, message: code } });
    }
    if (!(key in api.routes)) return json(404, { error: { code: 'NOT_FOUND', message: key } });
    return json(200, { data: api.routes[key] });
  });
}

export function renderWithQuery(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
