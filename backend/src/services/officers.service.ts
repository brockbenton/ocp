import type { AdminRole } from '@prisma/client';
import { hasAdminRoleOnChain } from './onchain.service';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

const OBSERVED_ON_CHAIN = 'on-chain';

/**
 * Reconciles the `admin_roles` records with the registry and returns the current
 * officers. The chain is the authority: a record whose wallet lost the role is
 * marked revoked, and a verified officer with no record (granted outside this
 * API) gets one. Throws if any role read fails, so nothing is changed on a guess.
 *
 * `knownOfficer` is a wallet the caller has already verified, which is how new
 * grants are picked up without scanning the chain's event history.
 */
export async function listOfficers(knownOfficer: string): Promise<AdminRole[]> {
  const records = await prisma.adminRole.findMany({ orderBy: { grantedAt: 'desc' } });
  const wallets = [...new Set([...records.map((r) => r.walletAddress), knownOfficer])];
  const holds = new Map(
    await Promise.all(
      wallets.map(async (wallet) => [wallet, await hasAdminRoleOnChain(wallet)] as const),
    ),
  );

  const now = new Date();
  const stale = records.filter((r) => !r.revokedAt && !holds.get(r.walletAddress));
  if (stale.length > 0) {
    await prisma.adminRole.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: { revokedAt: now },
    });
    logger.info({ msg: 'Marked officer records revoked on-chain', wallets: stale.map((r) => r.walletAddress) });
  }

  const recorded = new Set(records.filter((r) => !r.revokedAt).map((r) => r.walletAddress));
  const missing = wallets.filter((wallet) => holds.get(wallet) && !recorded.has(wallet));
  for (const walletAddress of missing) {
    await prisma.adminRole.create({ data: { walletAddress, grantedBy: OBSERVED_ON_CHAIN } });
    logger.info({ msg: 'Recorded officer observed on-chain', wallet: walletAddress });
  }

  // `distinct` hides a duplicate row left by two requests reconciling at once.
  return prisma.adminRole.findMany({
    where: { revokedAt: null },
    orderBy: { grantedAt: 'desc' },
    distinct: ['walletAddress'],
  });
}
