'use client';

import { useClub } from '@/hooks/useClub';

/** Shown while the founders' guardian can still cancel proposals. */
export default function BootstrapBanner() {
  const { data: club } = useClub();
  if (!club?.guardian.active) return null;
  const until = new Date(club.guardian.expiresAt * 1000).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <p role="note" className="rounded border border-amber bg-status-warn-bg px-4 py-3 text-sm text-status-warn">
      Bootstrap: founders can veto passed proposals until the first officer election, and no later
      than {until}.
    </p>
  );
}
