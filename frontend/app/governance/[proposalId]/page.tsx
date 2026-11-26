'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import ProposalActions from '@/components/features/governance/ProposalActions';
import ProposalStateBadge from '@/components/features/governance/ProposalStateBadge';
import VotePanel from '@/components/features/governance/VotePanel';
import LoadError from '@/components/shared/LoadError';
import { getProposal } from '@/lib/api/governance';
import { queryKeys } from '@/lib/api/queryKeys';
import { describeActions, matchesProposalId, proposalBody, proposalTitle } from '@/lib/proposals';
import { formatRep } from '@/lib/rep';
import { shortenAddress } from '@/lib/address';
import type { Proposal } from '@/types';

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString('en-US');

export default function ProposalPage() {
  const { proposalId } = useParams<{ proposalId: string }>();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.proposal(proposalId),
    queryFn: () => getProposal(proposalId),
    refetchInterval: 15_000,
  });

  if (error) return <LoadError what="proposal" onRetry={() => void refetch()} />;
  if (isLoading || !data) return <p className="text-sm text-content-secondary">Loading…</p>;

  // The id in the address bar commits to the exact text and actions. Anything else the
  // server sends is refused before the member can sign.
  const genuine = data.proposalId === proposalId && matchesProposalId(data);
  if (!genuine) {
    return (
      <p role="alert" className="rounded-xl border border-red/40 bg-status-neg-bg p-5 text-sm text-status-neg">
        This proposal&apos;s details don&apos;t match its on-chain id. Don&apos;t sign anything, and
        tell the officers.
      </p>
    );
  }

  const title = proposalTitle(data.description);
  const actions = describeActions(data);
  return (
    <>
      <Link href="/governance" className="block w-fit text-sm text-content-secondary hover:text-content">
        ← All proposals
      </Link>
      <header className="space-y-2">
        <ProposalStateBadge state={data.state} />
        <h1 className="text-[26px] font-medium leading-8 text-content">{title}</h1>
        <p className="font-mono text-xs text-content-secondary">
          Proposed by {shortenAddress(data.proposer)} · snapshot {when(data.snapshot)} · voting ends{' '}
          {when(data.deadline)}
        </p>
      </header>
      {proposalBody(data.description) && (
        <p className="whitespace-pre-wrap text-sm text-content">{proposalBody(data.description)}</p>
      )}
      <section aria-label="What it does" className="rounded-xl border border-line bg-surface p-5">
        <h2 className="mb-2 text-base font-medium text-content">What it does if it passes</h2>
        <ol className="list-decimal space-y-2 pl-5">
          {actions.map((action, i) => (
            <li
              key={i}
              className={`break-all text-sm ${action.understood ? 'text-content' : 'text-status-warn'}`}
            >
              {action.text}
            </li>
          ))}
        </ol>
      </section>
      <Tally proposal={data} />
      <VotePanel proposal={data} title={title} />
      <ProposalActions proposal={data} />
    </>
  );
}

function Tally({ proposal }: { proposal: Proposal }) {
  const rows = [
    { label: 'For', value: proposal.forVotes },
    { label: 'Against', value: proposal.againstVotes },
    { label: 'Abstain', value: proposal.abstainVotes },
  ];
  // For and Abstain count towards quorum.
  const counted = BigInt(proposal.forVotes) + BigInt(proposal.abstainVotes);
  return (
    <section aria-label="Tally" className="rounded-xl border border-line bg-surface p-5">
      <h2 className="mb-3 text-base font-medium text-content">Tally</h2>
      <dl className="grid grid-cols-3 gap-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-content-secondary">{row.label}</dt>
            <dd className="font-mono text-xl text-content">{formatRep(row.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm text-content-secondary">
        Quorum:{' '}
        {proposal.quorum === null
          ? 'TBD, set at the snapshot'
          : `${formatRep(counted)} of ${formatRep(proposal.quorum)} Rep needed (For and Abstain)`}
      </p>
    </section>
  );
}
