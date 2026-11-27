import type { User, WalletWithMetadata } from '@privy-io/react-auth';

/**
 * The user's primary Privy embedded wallet, lowercase: the same rule the backend
 * uses to identify a member. Linked external wallets are never identities.
 */
export function embeddedAddressOf(user: User | null | undefined): string | undefined {
  return user?.linkedAccounts
    .filter(
      (account): account is WalletWithMetadata =>
        account.type === 'wallet' &&
        account.walletClientType === 'privy' &&
        account.chainType === 'ethereum' &&
        !account.imported,
    )
    .sort((a, b) => (a.walletIndex ?? 0) - (b.walletIndex ?? 0))[0]
    ?.address.toLowerCase();
}
