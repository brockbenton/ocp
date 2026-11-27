'use client';

export const dynamic = 'force-dynamic';

import { useState, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import QRCode from 'react-qr-code';
import { getSession, getSessionQR } from '@/lib/api/admin';
import { queryKeys } from '@/lib/api/queryKeys';
import { requireIdentityToken, ApiRequestError } from '@/lib/api/client';
import { qrTiming, REFRESH_LEAD_MS } from '@/lib/qrTiming';

// How soon to try again after a failed fetch.
const RETRY_MS = 5_000;

export default function AdminSessionQRPage() {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (ready && !authenticated) {
      router.replace('/');
    }
  }, [ready, authenticated, router]);

  const { data: session } = useQuery({
    queryKey: queryKeys.session(sessionId),
    queryFn: async () => {
      const token = await requireIdentityToken();
      return getSession(sessionId, token);
    },
    enabled: authenticated && !!sessionId,
  });

  const {
    data: qrPayload,
    dataUpdatedAt,
    error: qrError,
    errorUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: queryKeys.sessionQR(sessionId),
    queryFn: async () => {
      const token = await requireIdentityToken();
      return getSessionQR(sessionId, token);
    },
    enabled: authenticated && !!sessionId,
    staleTime: Infinity,
    // Retries are scheduled below, so a failing refresh keeps being retried.
    retry: false,
  });

  const timing = qrPayload ? qrTiming(qrPayload, dataUpdatedAt) : null;
  const refreshAt = timing?.refreshAt;
  const isClosed = qrError instanceof ApiRequestError && qrError.status === 409;
  const msLeft = timing ? timing.expiresAt - Math.max(now, dataUpdatedAt) : 0;
  const showQR = !isClosed && msLeft > 0;
  // The refresh timer can lag the clock, e.g. after the projector laptop sleeps.
  const expired = timing !== null && msLeft <= 0;

  // Fetch the next QR while the current one is still valid; retry soon after a failure.
  useEffect(() => {
    if (isClosed) return;
    let delay: number;
    if (qrError) delay = RETRY_MS;
    else if (expired) delay = 0;
    else if (refreshAt !== undefined) delay = Math.max(0, refreshAt - Date.now());
    else return;
    const timer = setTimeout(() => void refetch(), delay);
    return () => clearTimeout(timer);
  }, [isClosed, expired, qrError, errorUpdatedAt, refreshAt, refetch]);

  // Drives the countdown and hides the QR once it expires.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!ready || !authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas">
        <div className="w-8 h-8 border-4 border-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <header className="flex items-center justify-between px-6 py-4 border-b border-line">
        <Link href="/admin/sessions" className="text-content-secondary hover:text-content">
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
            />
          </svg>
        </Link>

        <div className="text-center">
          {session ? (
            <>
              <p className="text-base font-semibold text-content">{session.name}</p>
              <p className="text-xs text-content-secondary">
                {formatDate(session.date)} &middot; {session.semester}
              </p>
            </>
          ) : (
            <p className="text-base font-semibold text-content">Check-In QR</p>
          )}
        </div>

        {/* spacer to keep title centered */}
        <div className="w-5" />
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 py-10 space-y-6">
        {showQR && qrPayload ? (
          <>
            <div className="p-5 bg-white border-2 border-line rounded-2xl">
              <QRCode value={qrPayload} size={320} />
            </div>

            <div className="text-center space-y-2">
              <CountdownLine secondsLeft={Math.floor(msLeft / 1000)} />
              {qrError && (
                <p role="alert" className="text-sm text-status-warn font-medium">
                  Couldn&apos;t refresh the code. Retrying&hellip;
                </p>
              )}
              <button
                onClick={() => void refetch()}
                className="text-xs text-content-muted hover:text-content-secondary underline"
              >
                Refresh now
              </button>
            </div>
          </>
        ) : qrError ? (
          <QRErrorState isClosed={isClosed} onRetry={() => void refetch()} />
        ) : (
          // Loading, or the last code expired and its replacement is not here yet.
          <div className="flex flex-col items-center gap-4">
            <div
              role="status"
              aria-label="Loading QR code"
              className="w-10 h-10 border-4 border-green border-t-transparent rounded-full animate-spin"
            />
            <button
              onClick={() => void refetch()}
              className="text-xs text-content-muted hover:text-content-secondary underline"
            >
              Refresh now
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

interface CountdownLineProps {
  secondsLeft: number;
}

function CountdownLine({ secondsLeft }: CountdownLineProps) {
  if (secondsLeft > REFRESH_LEAD_MS / 1000) {
    return (
      <p className="text-sm text-content-secondary">
        Valid for {formatCountdown(secondsLeft)}
      </p>
    );
  }
  return (
    <p className="text-sm text-status-warn font-medium">
      Expires in {formatCountdown(secondsLeft)}
    </p>
  );
}

interface QRErrorStateProps {
  isClosed: boolean;
  onRetry: () => void;
}

function QRErrorState({ isClosed, onRetry }: QRErrorStateProps) {
  return (
    <div className="text-center space-y-3">
      <p className="text-content font-medium">
        {isClosed
          ? 'This session is closed or not yet confirmed on-chain.'
          : 'Failed to load QR code. Retrying\u2026'}
      </p>
      {!isClosed && (
        <button onClick={onRetry} className="text-cyan text-sm hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}
