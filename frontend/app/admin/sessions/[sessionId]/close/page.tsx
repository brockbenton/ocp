'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import AdminPageHeader from '@/components/features/admin/AdminPageHeader';
import WalletBalance from '@/components/shared/WalletBalance';
import { getCloseList, getSession, syncSession } from '@/lib/api/admin';
import { queryKeys } from '@/lib/api/queryKeys';
import { requireIdentityToken } from '@/lib/api/client';
import { REGISTRY_ABI } from '@/lib/abi';
import { CONTRACT_ADDRESS, REP_PER_ATTENDANCE } from '@/lib/constants';
import { txErrorMessage } from '@/lib/txError';
import { useWalletTx } from '@/hooks/useWalletTx';

/** "End meeting": officer A closes the session with its attendee list; Rep becomes pending. */
export default function CloseSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const sendTx = useWalletTx();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const session = useQuery({
    queryKey: queryKeys.session(sessionId),
    queryFn: async () => getSession(sessionId, await requireIdentityToken()),
  });
  const list = useQuery({
    queryKey: queryKeys.closeList(sessionId),
    queryFn: async () => getCloseList(sessionId, await requireIdentityToken()),
    // Late check-ins finish minting while the officer reads the list.
    refetchInterval: (query) => (query.state.data?.waiting ? 4_000 : false),
  });

  const close = useMutation({
    mutationFn: async (attendees: `0x${string}`[]) => {
      await sendTx({
        address: CONTRACT_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'closeSession',
        args: [BigInt(sessionId), attendees],
        description: `End "${session.data?.name ?? sessionId}" with ${attendees.length} attendees. This can't be undone.`,
      });
      await syncSession(sessionId, await requireIdentityToken());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminSessions() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      router.push('/admin/sessions');
    },
    onError: () => {
      setConfirming(false);
      // The list may be out of date, or someone else may have closed it.
      void list.refetch();
      void session.refetch();
    },
  });

  if (session.data?.closedAt && !close.isPending) {
    return (
      <div className="space-y-6">
        <AdminPageHeader title="End meeting" caption={session.data.name} />
        <p className="text-sm text-content">This session is already closed.</p>
        <Link href="/admin/sessions" className="text-cyan text-sm">
          Back to sessions
        </Link>
      </div>
    );
  }

  const error = session.error ?? list.error;
  return (
    <div className="space-y-6">
      <AdminPageHeader title="End meeting" caption={session.data?.name} />
      {error ? (
        <p role="alert" className="text-status-neg text-sm">
          {txErrorMessage(error)}
        </p>
      ) : !list.data ? (
        <p className="text-sm text-content-secondary">Loading the attendee list…</p>
      ) : (
        <>
          <p className="text-sm text-content-secondary">
            Closing stops new tokens and submits this list. A <b>different</b> officer then approves
            it before anyone receives {REP_PER_ATTENDANCE} Rep.
          </p>
          {list.data.waiting > 0 && (
            <p role="status" className="text-sm text-status-warn">
              {list.data.waiting} check-in(s) are still being minted. Wait for them, or they will be
              left out and fail.
            </p>
          )}
          {list.data.failed > 0 && (
            <p className="text-sm text-status-neg">
              {list.data.failed} check-in(s) failed and are not on the list.
            </p>
          )}
          <section aria-label="Attendees" className="rounded-xl border border-line bg-surface">
            <h2 className="border-b border-line px-4 py-3 text-sm font-medium text-content">
              {list.data.attendees.length} attendee{list.data.attendees.length === 1 ? '' : 's'}
            </h2>
            <ul className="max-h-80 overflow-auto px-4 py-2">
              {list.data.attendees.map((wallet) => (
                <li key={wallet} className="py-1 font-mono text-xs text-content">
                  {wallet}
                </li>
              ))}
              {list.data.attendees.length === 0 && (
                <li className="py-1 text-xs text-content-secondary">
                  Nobody holds a token for this session. Closing it awards no Rep.
                </li>
              )}
            </ul>
          </section>
          {close.error && (
            <p role="alert" className="text-status-neg text-sm">
              {txErrorMessage(close.error)} The session is still open unless it shows as closed.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <WalletBalance />
            {close.isPending ? (
              <span className="text-sm text-content-secondary">Waiting for the chain…</span>
            ) : confirming ? (
              <span role="group" aria-label="Confirm closing" className="flex items-center gap-3 text-sm">
                <span className="text-content-secondary">Close for good?</span>
                <button type="button" onClick={() => close.mutate(list.data.attendees)} className="font-medium text-status-neg">
                  Yes, sign and close
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="text-content-secondary">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  close.reset();
                  setConfirming(true);
                }}
                className="rounded-lg bg-content px-5 py-2 text-sm font-semibold text-canvas hover:bg-content-secondary"
              >
                End meeting
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
