'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GOVERNOR_ABI } from '@/lib/abi';
import { GOVERNOR_ADDRESS } from '@/lib/constants';
import { queryKeys } from '@/lib/api/queryKeys';
import { descriptionHash, proposalTitle } from '@/lib/proposals';
import { txErrorMessage } from '@/lib/txError';
import { useWalletTx } from '@/hooks/useWalletTx';
import WalletBalance from '@/components/shared/WalletBalance';
import type { Proposal } from '@/types';

function countdown(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

/** Queueing a passed proposal and, after the Timelock delay, executing it. */
export default function ProposalActions({ proposal }: { proposal: Proposal }) {
  const { authenticated } = usePrivy();
  const sendTx = useWalletTx();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const eta = proposal.queuedEta ? Date.parse(proposal.queuedEta) : null;

  useEffect(() => {
    if (proposal.state !== 'Queued') return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [proposal.state]);

  const act = useMutation({
    mutationFn: async (functionName: 'queue' | 'execute') =>
      sendTx({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName,
        args: [
          proposal.targets,
          proposal.values.map(BigInt),
          proposal.calldatas,
          descriptionHash(proposal.description),
        ],
        description: `${functionName === 'queue' ? 'Queue' : 'Execute'} "${proposalTitle(proposal.description)}".`,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposal.proposalId) }),
  });

  if (proposal.state !== 'Succeeded' && proposal.state !== 'Queued') return null;
  const waiting = proposal.state === 'Queued' && (eta === null || eta > now);

  return (
    <section aria-label="Next step" className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <p className="text-sm text-content">
        {proposal.state === 'Succeeded'
          ? 'The vote passed. Anyone can queue it, which starts the Timelock delay.'
          : waiting
            ? eta === null
              ? 'Queued. Waiting for the Timelock time to be indexed.'
              : `Queued. Executable in ${countdown(eta - now)}.`
            : 'The delay has passed. Anyone can execute it.'}
      </p>
      {authenticated ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <WalletBalance />
          <button
            type="button"
            onClick={() => act.mutate(proposal.state === 'Succeeded' ? 'queue' : 'execute')}
            disabled={act.isPending || waiting}
            className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
          >
            {act.isPending ? 'Waiting for the chain…' : proposal.state === 'Succeeded' ? 'Queue' : 'Execute'}
          </button>
        </div>
      ) : (
        <p className="text-xs text-content-secondary">Sign in to send the transaction.</p>
      )}
      {act.error && (
        <p role="alert" className="text-sm text-status-neg">
          {txErrorMessage(act.error)}
        </p>
      )}
    </section>
  );
}
