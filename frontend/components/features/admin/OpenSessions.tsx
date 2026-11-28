'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { useClub } from '@/hooks/useClub';
import type { SessionWithCount } from '@/types';

const HOUR_MS = 3_600_000;
const DEFAULT_WARN_HOURS = 6;

function openFor(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 48) return `${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `${hours} h`;
  return `${Math.max(0, Math.floor(ms / 60_000))} min`;
}

/** Meetings still open, how long for, and a nudge to close the old ones. */
export default function OpenSessions({ sessions }: { sessions: SessionWithCount[] }) {
  const { data: club } = useClub();
  const warnHours = club?.openSessionWarnHours ?? DEFAULT_WARN_HOURS;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const open = sessions.filter(
    (s) => s.isCurrentRegistry && s.onchainStatus === 'CONFIRMED' && !s.closedAt,
  );
  if (open.length === 0) return null;

  return (
    <section aria-label="Open sessions">
      <h2 className="text-base font-medium text-content mb-4">Open now</h2>
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {open.map((session) => {
          const age = now - Date.parse(session.createdAt);
          const stale = age > warnHours * HOUR_MS;
          return (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-content">{session.name}</p>
                <p className="text-xs text-content-secondary">
                  Open for {openFor(age)} · {session.attendeeCount} of {session.maxAttendees} checked in
                </p>
              </div>
              <div className="flex items-center gap-3">
                {stale && <Badge tone="warn">Still open, close it?</Badge>}
                <Link
                  href={`/admin/sessions/${encodeURIComponent(session.sessionId)}/close`}
                  className="text-status-neg text-xs font-medium"
                >
                  End meeting
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
