'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REGISTRY_ABI } from '@/lib/abi';
import { CONTRACT_ADDRESS } from '@/lib/constants';
import { queryKeys } from '@/lib/api/queryKeys';
import { txErrorMessage } from '@/lib/txError';
import { useClub } from '@/hooks/useClub';
import { useEmbeddedAddress } from '@/hooks/useProfile';
import { useWalletTx } from '@/hooks/useWalletTx';

/** The emergency stop for token minting, for example if the relay key leaks. */
export default function PausePanel() {
  const { data: club } = useClub();
  const address = useEmbeddedAddress();
  const sendTx = useWalletTx();
  const queryClient = useQueryClient();

  const { mutate, isPending, error } = useMutation({
    mutationFn: async (functionName: 'pauseMinting' | 'unpauseMinting') =>
      sendTx({
        address: CONTRACT_ADDRESS,
        abi: REGISTRY_ABI,
        functionName,
        description:
          functionName === 'pauseMinting'
            ? 'Pause token minting for 14 days.'
            : 'Approve resuming token minting. Two officers are needed.',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.club() }),
  });

  if (!club) return null;
  const { paused, pausedUntil, unpauseApprover } = club.pause;
  const approvedByMe = unpauseApprover === address;

  return (
    <section className="rounded-xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-content">Token minting</h2>
          <p className="mt-1 text-sm text-content-secondary">
            {paused
              ? `Paused until ${new Date(pausedUntil * 1000).toLocaleString('en-US')}. ${
                  unpauseApprover
                    ? 'One officer has approved resuming; a second is needed.'
                    : 'Resuming needs two officers.'
                }`
              : 'Active. Pausing stops new tokens for 14 days; closing and approving still work. Each officer may pause once per 30 days.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => mutate(paused ? 'unpauseMinting' : 'pauseMinting')}
          disabled={isPending || (paused && approvedByMe)}
          className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-content hover:bg-raised disabled:opacity-50"
        >
          {isPending ? 'Waiting for the chain…' : paused ? (approvedByMe ? 'You approved' : 'Resume minting') : 'Pause minting'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-status-neg">
          {txErrorMessage(error)}
        </p>
      )}
    </section>
  );
}
