'use client';

import { useQuery } from '@tanstack/react-query';
import { getMemberRep } from '@/lib/api/members';
import { queryKeys } from '@/lib/api/queryKeys';
import { REP_PER_ATTENDANCE } from '@/lib/constants';
import { formatAsOf, formatRep } from '@/lib/rep';
import { useClub } from '@/hooks/useClub';
import { Badge } from '@/components/ui';

const DAY_SECONDS = 86_400;
const REFRESH_MS = 60_000;

const WAITING_LABEL = {
  PENDING_APPROVAL: 'Rep pending',
  AWAITING_CREDIT: 'Approved, credit processing',
} as const;

/** Current voting power, how it is earned and fades, and what is still on the way. */
export default function RepCard({ address }: { address: string | undefined }) {
  const { data: club } = useClub();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.memberRep(address ?? ''),
    queryFn: () => getMemberRep(address!),
    enabled: !!address,
    // Rep fades with time even when nothing happens, so keep re-reading it.
    refetchInterval: REFRESH_MS,
  });
  const halfLife = club ? Math.round(club.repHalfLifeSeconds / DAY_SECONDS) : null;

  return (
    <section aria-label="Your Rep" className="rounded-lg border border-line bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-content">Your Rep</h2>
        <span className="font-mono text-xs text-content-secondary">{formatAsOf(data?.asOf)}</span>
      </div>
      {error || (data && data.rep === null) ? (
        <p className="mt-2 text-sm text-content-secondary">
          Couldn&apos;t read your Rep from the chain just now.
        </p>
      ) : (
        <p className="mt-2 font-mono text-4xl font-medium text-content" data-testid="current-rep">
          {isLoading || !data ? '…' : formatRep(data.rep)}
        </p>
      )}
      <p className="mt-2 text-sm text-content-secondary">
        +{REP_PER_ATTENDANCE} Rep per verified attendance, once two officers approve the meeting. Rep
        is your voting power and fades gradually
        {halfLife ? `: half of it every ${halfLife} days` : ''}. Your attendance history never
        fades.
      </p>
      {!!data?.waiting.length && (
        <ul className="mt-4 space-y-2 border-t border-line pt-4">
          {data.waiting.map((item) => (
            <li key={item.sessionId} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-content">{item.name}</span>
              <Badge tone="warn">
                {WAITING_LABEL[item.status as keyof typeof WAITING_LABEL] ?? 'Pending'}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
