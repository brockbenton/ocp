import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetFakes, privy, router, params, chain, OFFICER } from './harness';

vi.mock('@privy-io/react-auth', () => ({
  getIdentityToken: async () => 'test-token',
  usePrivy: () => ({
    ready: true,
    authenticated: privy.authenticated,
    user: privy.authenticated
      ? {
          id: 'did:privy:officer',
          linkedAccounts: [{ type: 'wallet', walletClientType: 'privy', chainType: 'ethereum', address: OFFICER }],
        }
      : null,
    login: vi.fn(),
  }),
  useSendTransaction: () => ({ sendTransaction: (...args: unknown[]) => privy.sendTransaction(...args) }),
  useSignTypedData: () => ({ signTypedData: (...args: unknown[]) => privy.signTypedData(...args) }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => params,
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/chain', () => ({ publicClient: chain }));

beforeEach(resetFakes);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
