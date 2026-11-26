'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getSessionDefaults, previewMetadata, syncSession } from '@/lib/api/admin';
import { queryKeys } from '@/lib/api/queryKeys';
import { requireIdentityToken } from '@/lib/api/client';
import { REGISTRY_ABI } from '@/lib/abi';
import { CONTRACT_ADDRESS } from '@/lib/constants';
import { semesterFor } from '@/lib/semester';
import { txErrorMessage } from '@/lib/txError';
import { useWalletTx } from '@/hooks/useWalletTx';
import WalletBalance from '@/components/shared/WalletBalance';
import type { MetadataPreview } from '@/types';

const MAX_ATTENDEES = 300;

// Keeps the picked day in local time, and the meeting timer starts from this time of day.
function dayAtCurrentTime(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const at = new Date();
  at.setFullYear(year, month - 1, date);
  return at;
}

interface Draft {
  sessionId: string;
  name: string;
  date: Date;
  maxAttendees: number;
  preview: MetadataPreview;
}

const INPUT =
  'w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green';

/**
 * Starts a meeting from the officer's own wallet: first review exactly what will be
 * written on-chain, including the token metadata and its CID, then sign.
 */
export default function StartMeetingForm() {
  const router = useRouter();
  const sendTx = useWalletTx();
  const [name, setName] = useState('');
  const [day, setDay] = useState('');
  const [cap, setCap] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [startedNote, setStartedNote] = useState(false);

  const { data: defaults } = useQuery({
    queryKey: queryKeys.sessionDefaults(),
    queryFn: async () => getSessionDefaults(await requireIdentityToken()),
  });
  const maxAttendees = cap === '' ? String(defaults?.suggestedMaxAttendees ?? '') : cap;

  const review = useMutation({
    mutationFn: async (): Promise<Draft> => {
      const sessionId = Date.now().toString();
      const date = dayAtCurrentTime(day);
      const preview = await previewMetadata(
        { sessionId, name: name.trim(), date: date.toISOString() },
        await requireIdentityToken(),
      );
      return { sessionId, name: name.trim(), date, maxAttendees: Number(maxAttendees), preview };
    },
    onSuccess: setDraft,
  });

  const start = useMutation({
    mutationFn: async (meeting: Draft) => {
      await sendTx({
        address: CONTRACT_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'createSession',
        args: [
          BigInt(meeting.sessionId),
          BigInt(Math.floor(meeting.date.getTime() / 1000)),
          meeting.name,
          semesterFor(meeting.date),
          meeting.maxAttendees,
          meeting.preview.cid ?? '',
        ],
        description: `Start the meeting "${meeting.name}" with up to ${meeting.maxAttendees} attendees.`,
      });
      const synced = await syncSession(meeting.sessionId, await requireIdentityToken());
      return { sessionId: meeting.sessionId, synced };
    },
    onSuccess: ({ sessionId, synced }) => {
      if (synced) {
        router.push(`/admin/sessions/${sessionId}/qr`);
        return;
      }
      // The meeting exists on-chain; it appears in the list once indexed.
      setDraft(null);
      setStartedNote(true);
    },
  });

  const capValid =
    /^\d+$/.test(maxAttendees) && Number(maxAttendees) >= 1 && Number(maxAttendees) <= MAX_ATTENDEES;

  return (
    <section>
      <h2 className="text-base font-medium text-content mb-4">Start a meeting</h2>
      <div className="bg-surface border border-line rounded-xl p-6 space-y-4">
        {!draft ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setStartedNote(false);
              if (name.trim() && day && capValid) review.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="space-y-1 block text-sm font-medium text-content">
                Meeting name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Kickoff"
                  maxLength={200}
                  className={INPUT}
                  required
                />
              </label>
              <label className="space-y-1 block text-sm font-medium text-content">
                Date
                <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={INPUT} required />
              </label>
              <label className="space-y-1 block text-sm font-medium text-content">
                Maximum attendees
                <input
                  type="number"
                  min={1}
                  max={MAX_ATTENDEES}
                  value={maxAttendees}
                  onChange={(e) => setCap(e.target.value)}
                  className={INPUT}
                  required
                />
              </label>
            </div>
            <p className="text-xs text-content-secondary">
              The cap limits how many attendance tokens can be minted. It is suggested from recent
              meetings and can&apos;t be changed afterwards.
            </p>
            {startedNote && (
              <p role="status" className="text-sm text-status-pos">
                The meeting is on-chain. It will appear in the list in a moment; open its QR from
                there.
              </p>
            )}
            {review.error && (
              <p role="alert" className="text-status-neg text-sm">
                {txErrorMessage(review.error)}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <WalletBalance />
              <button
                type="submit"
                disabled={review.isPending || !capValid}
                className="py-2 px-5 rounded-lg bg-content text-canvas text-sm font-semibold hover:bg-content-secondary disabled:opacity-50 transition-colors"
              >
                {review.isPending ? 'Preparing…' : 'Review'}
              </button>
            </div>
          </form>
        ) : (
          <MeetingReview
            draft={draft}
            pending={start.isPending}
            error={start.error}
            onBack={() => {
              start.reset();
              setDraft(null);
            }}
            onSign={() => start.mutate(draft)}
          />
        )}
      </div>
    </section>
  );
}

interface MeetingReviewProps {
  draft: Draft;
  pending: boolean;
  error: unknown;
  onBack: () => void;
  onSign: () => void;
}

function MeetingReview({ draft, pending, error, onBack, onSign }: MeetingReviewProps) {
  const { metadata, cid } = draft.preview;
  return (
    <div className="space-y-4" aria-label="Review before signing">
      <p className="text-sm text-content">
        You are about to start <b>{draft.name}</b> on {draft.date.toLocaleDateString('en-US')} for up
        to <b>{draft.maxAttendees}</b> attendees.
      </p>
      <div className="rounded-lg border border-line p-4 text-xs space-y-2">
        <p className="font-medium text-content">Token metadata</p>
        <dl className="grid grid-cols-[110px_1fr] gap-1 text-content-secondary">
          <dt>Name</dt>
          <dd className="text-content">{metadata.name}</dd>
          <dt>Description</dt>
          <dd className="text-content">{metadata.description}</dd>
          <dt>Image</dt>
          <dd className="font-mono break-all">{metadata.image}</dd>
          {metadata.attributes.map((attribute) => (
            <div key={attribute.trait_type} className="contents">
              <dt>{attribute.trait_type}</dt>
              <dd className="text-content">{attribute.value}</dd>
            </div>
          ))}
          <dt>Metadata CID</dt>
          <dd className="font-mono break-all text-content" data-testid="metadata-cid">
            {cid ?? 'None: this token will use the club’s base metadata'}
          </dd>
        </dl>
        {cid && (
          <a
            href={`https://gateway.pinata.cloud/ipfs/${cid}`}
            target="_blank"
            rel="noreferrer"
            className="text-cyan hover:text-content"
          >
            Open the pinned file to check it
          </a>
        )}
      </div>
      {!!error && (
        <p role="alert" className="text-status-neg text-sm">
          {txErrorMessage(error)}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <WalletBalance />
        <div className="flex gap-2">
          <button type="button" onClick={onBack} disabled={pending} className="px-4 text-sm text-content-secondary">
            Back
          </button>
          <button
            type="button"
            onClick={onSign}
            disabled={pending}
            className="py-2 px-5 rounded-lg bg-content text-canvas text-sm font-semibold hover:bg-content-secondary disabled:opacity-50"
          >
            {pending ? 'Waiting for the chain…' : 'Sign and start'}
          </button>
        </div>
      </div>
    </div>
  );
}
