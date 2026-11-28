'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import AdminPageHeader from '@/components/features/admin/AdminPageHeader';
import { shortenAddress } from '@/lib/address';
import { BASESCAN_URL } from '@/lib/constants';
import { useClub } from '@/hooks/useClub';
import { useEmbeddedAddress } from '@/hooks/useProfile';

/** The officer roster, read from the registry. Changing it takes a passed proposal. */
export default function OfficersPage() {
  const { data: club, isLoading, error } = useClub();
  const myWallet = useEmbeddedAddress();

  return (
    <div className="space-y-10">
      <AdminPageHeader title="Officers" caption="Wallets that run meetings" />

      <p className="rounded-lg border border-line bg-surface p-4 text-sm text-content-secondary">
        Officers can&apos;t add or remove officers directly. Role changes need the club&apos;s
        governance approval:{' '}
        <Link href="/governance/new" className="text-cyan hover:text-content">
          create a proposal
        </Link>
        . The registry always keeps at least two.
      </p>

      {isLoading && <p className="text-sm text-content-secondary">Loading…</p>}
      {!!error && <p className="text-sm text-status-neg">Couldn&apos;t read the officer list from the chain.</p>}

      {club && (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {club.officers.map((officer) => (
              <li key={officer.walletAddress} className="flex items-center justify-between px-4 py-3 text-sm">
                <a
                  href={`${BASESCAN_URL}/address/${officer.walletAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-content hover:text-cyan"
                  title={officer.walletAddress}
                >
                  {shortenAddress(officer.walletAddress)}
                </a>
                <span className="text-content-secondary">
                  {officer.username ?? ''}
                  {officer.walletAddress === myWallet && <span className="ml-2 text-xs text-cyan">(you)</span>}
                </span>
              </li>
            ))}
          </ul>
          <section className="text-sm text-content-secondary">
            <h2 className="mb-2 text-base font-medium text-content">Founders&apos; veto</h2>
            {club.guardian.active ? (
              <p>
                <span className="font-mono">{shortenAddress(club.guardian.address)}</span> can cancel
                queued proposals until{' '}
                {new Date(club.guardian.expiresAt * 1000).toLocaleDateString('en-US')}. It cannot
                create or execute them.
              </p>
            ) : (
              <p>The bootstrap veto has ended.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
