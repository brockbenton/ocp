'use client';

export const dynamic = 'force-dynamic';

import { usePrivy } from '@privy-io/react-auth';
import { useQuery } from '@tanstack/react-query';
import AdminPageHeader from '@/components/features/admin/AdminPageHeader';
import { queryKeys } from '@/lib/api/queryKeys';
import { listAdminRoles } from '@/lib/api/admin';
import { requireIdentityToken, retryUnlessForbidden } from '@/lib/api/client';

function truncateWallet(addr: string): string {
  return addr.startsWith('0x') ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function AdminRolesPage() {
  const { user } = usePrivy();

  const { data: roles, isLoading, error } = useQuery({
    queryKey: queryKeys.adminRoles(),
    queryFn: async () => {
      const token = await requireIdentityToken();
      return listAdminRoles(token);
    },
    retry: retryUnlessForbidden,
  });

  const myWallet = user?.wallet?.address?.toLowerCase();

  return (
    <div className="space-y-10">
      <AdminPageHeader title="Roles" caption="Wallets that can manage the club" />

      <p className="rounded-lg border border-line bg-surface p-4 text-sm text-content-secondary">
        Officers can&apos;t add or remove officers from this dashboard. Role changes need the
        club&apos;s governance approval. An officer added from a wallet is listed here once they
        have opened this page.
      </p>

      <section>
        <h2 className="text-base font-medium text-content mb-4">Current Admins</h2>
        {isLoading && <p className="text-sm text-content-secondary">Loading…</p>}
        {!!error && <p className="text-sm text-status-neg">Failed to load roles.</p>}

        {roles && roles.length === 0 && (
          <p className="text-sm text-content-secondary">No active admin roles.</p>
        )}

        {roles && roles.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-raised text-content-secondary text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">Wallet</th>
                  <th className="px-4 py-3 font-medium">Granted By</th>
                  <th className="px-4 py-3 font-medium">Recorded At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line bg-surface">
                {roles.map((role) => (
                  <tr key={role.id} className="hover:bg-raised">
                    <td className="px-4 py-3 font-mono">
                      <span title={role.walletAddress}>{truncateWallet(role.walletAddress)}</span>
                      {role.walletAddress === myWallet && (
                        <span className="ml-2 text-xs text-cyan font-sans">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-content-secondary">
                      <span title={role.grantedBy}>{truncateWallet(role.grantedBy)}</span>
                    </td>
                    <td className="px-4 py-3 text-content-secondary">{formatDate(role.grantedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
