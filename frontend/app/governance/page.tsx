'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import ProposalStateBadge from '@/components/features/governance/ProposalStateBadge';
import SubmitSignedVote from '@/components/features/governance/SubmitSignedVote';
import LoadError from '@/components/shared/LoadError';
import { listProposals } from '@/lib/api/governance';
import { queryKeys } from '@/lib/api/queryKeys';
import { proposalTitle } from '@/lib/proposals';
import { formatRep } from '@/lib/rep';
import { useAdminMe } from '@/hooks/useAdminMe';

export default function GovernancePage() {
  const { data: me } = useAdminMe();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.proposals(),
    queryFn: listProposals,
    refetchInterval: 30_000,
  });

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[30px] font-medium leading-9 text-content">Governance</h1>
          <p className="mt-1 text-sm text-content-secondary">
            Members vote with their Rep, for free. Passed proposals run after a delay.
          </p>
        </div>
        <Link
          href="/governance/new"
          className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas"
        >
          New proposal
        </Link>
      </div>

      {error ? (
        <LoadError what="proposals" onRetry={() => void refetch()} />
      ) : isLoading ? (
        <p className="text-sm text-content-secondary">Loading…</p>
      ) : !data?.length ? (
        <p className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-content-secondary">
          No proposals yet.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {data.map((proposal) => (
            <li key={proposal.proposalId}>
              <Link
                href={`/governance/${proposal.proposalId}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-raised"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-content">
                    {proposalTitle(proposal.description)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-content-secondary">
                    For {formatRep(proposal.forVotes)} · Against {formatRep(proposal.againstVotes)}
                  </p>
                </div>
                <ProposalStateBadge state={proposal.state} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {me?.isAdmin && <SubmitSignedVote />}
    </>
  );
}
