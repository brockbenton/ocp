'use client';

export const dynamic = 'force-dynamic';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import AdminPageHeader from '@/components/features/admin/AdminPageHeader';
import WalletBalance from '@/components/shared/WalletBalance';
import { getReviewQueue, syncSession } from '@/lib/api/admin';
import { queryKeys } from '@/lib/api/queryKeys';
import { requireIdentityToken, retryUnlessForbidden } from '@/lib/api/client';
import { REGISTRY_ABI } from '@/lib/abi';
import { CONTRACT_ADDRESS, REP_PER_ATTENDANCE } from '@/lib/constants';
import { shortenAddress } from '@/lib/address';
import { txErrorMessage } from '@/lib/txError';
import { useWalletTx } from '@/hooks/useWalletTx';
import type { ReviewItem } from '@/types';

export default function ReviewPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.reviewQueue(),
    queryFn: async () => getReviewQueue(await requireIdentityToken()),
    retry: retryUnlessForbidden,
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-6">
      <AdminPageHeader title="Review" caption="Closed meetings waiting for a second officer" />
      <p className="text-sm text-content-secondary">
        Approving gives every listed wallet {REP_PER_ATTENDANCE} Rep of voting power. Check that
        these people were there. Rejecting is permanent; attendance tokens remain either way.
      </p>
      <WalletBalance />
      {isLoading ? (
        <p className="text-sm text-content-secondary">Loading…</p>
      ) : !!error ? (
        <p role="alert" className="text-sm text-status-neg">
          Couldn&apos;t load the review queue.
        </p>
      ) : !data?.length ? (
        <p className="text-sm text-content-secondary">Nothing is waiting for approval.</p>
      ) : (
        data.map((item) => <ReviewCard key={item.id} item={item} />)
      )}
    </div>
  );
}

function ReviewCard({ item }: { item: ReviewItem }) {
  const sendTx = useWalletTx();
  const queryClient = useQueryClient();

  const decide = useMutation({
    mutationFn: async (functionName: 'confirmSessionRep' | 'rejectSessionRep') => {
      await sendTx({
        address: CONTRACT_ADDRESS,
        abi: REGISTRY_ABI,
        functionName,
        args: [BigInt(item.sessionId)],
        description:
          functionName === 'confirmSessionRep'
            ? `Approve ${REP_PER_ATTENDANCE} Rep for each of ${item.attendees.length} attendees of "${item.name}".`
            : `Reject the Rep for "${item.name}". This can't be undone.`,
      });
      await syncSession(item.sessionId, await requireIdentityToken());
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.reviewQueue() }),
  });

  return (
    <article aria-label={item.name} className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <header>
        <h2 className="text-base font-medium text-content">{item.name}</h2>
        <p className="text-xs text-content-secondary">
          {item.attendees.length} listed · cap {item.maxAttendees} · closed by{' '}
          <span className="font-mono">{item.closedBy ? shortenAddress(item.closedBy) : 'unknown'}</span>
          {item.closedAt && ` on ${new Date(item.closedAt).toLocaleString('en-US')}`}
        </p>
      </header>
      {item.flags.length > 0 && (
        <ul aria-label="Warnings" className="space-y-1 rounded-lg bg-status-warn-bg p-3 text-sm text-status-warn">
          {item.flags.map((flag) => (
            <li key={flag.code}>
              {flag.message}
              {flag.wallets && flag.wallets.length > 0 && (
                <span className="font-mono text-xs"> ({flag.wallets.map(shortenAddress).join(', ')})</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-cyan">Show attendees</summary>
        <ul className="mt-2 max-h-72 overflow-auto">
          {item.attendees.map((a) => (
            <li key={a.walletAddress} className="py-0.5 font-mono text-xs text-content">
              {a.walletAddress}
              {a.username && <span className="text-content-secondary"> · {a.username}</span>}
            </li>
          ))}
        </ul>
      </details>
      {decide.error && (
        <p role="alert" className="text-sm text-status-neg">
          {txErrorMessage(decide.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {!item.canConfirm && (
          <span className="mr-auto text-xs text-content-secondary">
            You closed this meeting, so another officer has to approve it.
          </span>
        )}
        <button
          type="button"
          onClick={() => decide.mutate('rejectSessionRep')}
          disabled={decide.isPending}
          className="rounded-lg border border-line-strong px-4 py-2 text-sm text-status-neg disabled:opacity-50"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => decide.mutate('confirmSessionRep')}
          disabled={decide.isPending || !item.canConfirm}
          className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
        >
          {decide.isPending ? 'Waiting for the chain…' : 'Approve'}
        </button>
      </div>
    </article>
  );
}
