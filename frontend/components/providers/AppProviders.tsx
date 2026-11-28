'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CHAIN } from '@/lib/constants';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

interface AppProvidersProps {
  children: React.ReactNode;
}

export default function AppProviders({ children }: AppProvidersProps) {
  // No `typeof window` gate on purpose: it would fork server vs. first client
  // paint, forcing a hydration mismatch that re-mounts the (SSR-safe) provider.
  // next.config.mjs fails the build when this env var is missing.
  return (
    <QueryClientProvider client={queryClient}>
      <PrivyProvider
        appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID as string}
        config={{
          defaultChain: CHAIN,
          supportedChains: [CHAIN],
          appearance: {
            theme: 'dark',
            accentColor: '#22D974',
          },
          embeddedWallets: {
            // Members confirm every signature and transaction themselves. Never enable
            // delegated actions or session signers: they would let a server sign (#70).
            showWalletUIs: true,
            ethereum: {
              createOnLogin: 'users-without-wallets',
            },
          },
          loginMethods: ['email', 'google', 'passkey'],
        }}
      >
        {children}
      </PrivyProvider>
    </QueryClientProvider>
  );
}
