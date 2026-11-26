import type { User } from '@privy-io/server-auth';
import { Prisma, type Member } from '@prisma/client';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

/**
 * The user's Privy embedded Ethereum wallets, lowercase, lowest HD index first.
 * Linked external wallets (MetaMask and the like) are never identities.
 */
export function embeddedWalletsOf(user: Pick<User, 'linkedAccounts'>): string[] {
  return (user.linkedAccounts ?? [])
    .flatMap((account) => {
      if (account.type !== 'wallet') return [];
      const embedded = account.walletClientType === 'privy' || account.connectorType === 'embedded';
      const ethereum = !account.chainType || account.chainType === 'ethereum';
      if (!embedded || !ethereum || account.imported) return [];
      return [{ address: account.address.toLowerCase(), index: account.hdWalletIndex ?? 0 }];
    })
    .sort((a, b) => a.index - b.index)
    .map((wallet) => wallet.address);
}

/**
 * The wallet that identifies this user: the embedded wallet already stored on their
 * member record, otherwise their primary embedded wallet. Null when they have none.
 */
export async function resolveIdentity(user: Pick<User, 'id' | 'linkedAccounts'>): Promise<string | null> {
  const embedded = embeddedWalletsOf(user);
  if (embedded.length === 0) return null;

  const member = await prisma.member.findUnique({
    where: { privyUserId: user.id },
    select: { walletAddress: true },
  });
  return member && embedded.includes(member.walletAddress) ? member.walletAddress : embedded[0];
}

/**
 * The member record for an identity, creating it on first use. A record this user
 * made earlier under another wallet keeps its history (tokens stay with that
 * address on-chain) but gives up the Privy link to the identity's record.
 */
export async function findOrCreateMember(
  walletAddress: string,
  privyUserId: string,
  patch: Omit<Prisma.MemberUpdateInput, 'walletAddress' | 'privyUserId' | 'checkIns'> = {},
): Promise<Member> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.member.findUnique({ where: { privyUserId } });
    if (previous && previous.walletAddress !== walletAddress) {
      await tx.member.update({ where: { id: previous.id }, data: { privyUserId: null } });
      logger.warn({
        msg: 'Moved a Privy link to the identity wallet',
        memberId: previous.id,
        from: previous.walletAddress,
        to: walletAddress,
      });
    }
    return tx.member.upsert({
      where: { walletAddress },
      update: { ...patch, privyUserId },
      create: { ...(patch as Prisma.MemberCreateInput), walletAddress, privyUserId },
    });
  });
}
