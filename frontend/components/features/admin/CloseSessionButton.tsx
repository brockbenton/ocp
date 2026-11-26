'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { closeSession } from '@/lib/api/admin';
import { queryKeys } from '@/lib/api/queryKeys';
import { requireIdentityToken, ApiRequestError } from '@/lib/api/client';

interface CloseSessionButtonProps {
  sessionId: string;
  sessionName: string;
}

function closeErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) return 'This session was already closed.';
    if (error.code === 'CHAIN_ERROR') {
      return 'The on-chain close failed. The session is still open; try again.';
    }
    return error.message;
  }
  return 'Could not close the session. Check your connection and try again.';
}

export default function CloseSessionButton({ sessionId, sessionName }: CloseSessionButtonProps) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const refreshSessions = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSessions() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }),
    ]);

  const { mutate, isPending, error, reset } = useMutation({
    mutationFn: async () => {
      const token = await requireIdentityToken();
      return closeSession(sessionId, token);
    },
    onSuccess: refreshSessions,
    onError: (err) => {
      setConfirming(false);
      // 409 means the list is stale: someone else closed it, so reload the truth.
      if (err instanceof ApiRequestError && err.status === 409) void refreshSessions();
    },
  });

  if (isPending) {
    return <span className="text-content-secondary text-xs">Closing&hellip;</span>;
  }

  if (confirming) {
    return (
      <span role="group" aria-label={`Close ${sessionName}`} className="flex items-center gap-2 text-xs">
        <span className="text-content-secondary">Close for good?</span>
        <button type="button" onClick={() => mutate()} className="text-status-neg font-medium">
          Yes, close
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-content-secondary hover:text-content font-medium"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-status-neg text-xs max-w-[220px] text-left">
          {closeErrorMessage(error)}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          reset();
          setConfirming(true);
        }}
        className="text-status-neg text-xs font-medium"
      >
        Close
      </button>
    </span>
  );
}
