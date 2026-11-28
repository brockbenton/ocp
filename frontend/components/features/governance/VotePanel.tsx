'use client';

import { useEffect, useState } from 'react';
import { usePrivy, useSignTypedData } from '@privy-io/react-auth';
import { useMutation, useQuery } from '@tanstack/react-query';
import { GOVERNOR_ABI } from '@/lib/abi';
import { CHAIN, GOVERNOR_ADDRESS } from '@/lib/constants';
import { publicClient } from '@/lib/chain';
import { getMyVote, relayVote } from '@/lib/api/governance';
import { ApiRequestError, requireIdentityToken } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/queryKeys';
import { ballotTypedData } from '@/lib/typedData';
import { formatRep } from '@/lib/rep';
import { txErrorMessage } from '@/lib/txError';
import { parseSignedVote, SUPPORT_LABELS } from '@/lib/votePayload';
import { useEmbeddedAddress } from '@/hooks/useProfile';
import { useWalletTx } from '@/hooks/useWalletTx';
import type { Proposal, SignedVote } from '@/types';

/** After this long without appearing on-chain, the member is told to use another route. */
export const LANDING_TIMEOUT_MS = 60_000;
const POLL_MS = 5_000;
// For, Against, Abstain: the order people expect, not the contract's numbering.
const CHOICES = [1, 0, 2] as const;

const storageKey = (proposalId: string, voter: string) => `ocp-vote:${proposalId}:${voter}`;

/** The relay refuses a second ballot while an earlier one is still on its way. */
const isVotePending = (error: unknown) =>
  error instanceof ApiRequestError && error.code === 'VOTE_PENDING';

interface VotePanelProps {
  proposal: Proposal;
  title: string;
}

/**
 * Gasless voting. The member sees the proposal title and their choice before signing,
 * the relay submits the signature, and the browser checks the chain itself to see that
 * the vote landed. If it doesn't, the signed vote can be submitted by anyone.
 */
export default function VotePanel({ proposal, title }: VotePanelProps) {
  const { authenticated, user, login } = usePrivy();
  const address = useEmbeddedAddress();
  const { signTypedData } = useSignTypedData();
  const sendTx = useWalletTx();
  const [choice, setChoice] = useState<0 | 1 | 2 | null>(null);
  const [signed, setSigned] = useState<SignedVote | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // Set by "Sign again", so the earlier signature the backend holds is not shown.
  const [discarded, setDiscarded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { proposalId, state } = proposal;

  // Read straight from the chain: the backend's word is not enough here.
  const landed = useQuery({
    queryKey: queryKeys.onchainVote(proposalId, address ?? ''),
    queryFn: () =>
      publicClient.readContract({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName: 'hasVoted',
        args: [BigInt(proposalId), address as `0x${string}`],
      }),
    enabled: !!address,
    refetchInterval: (query) => (query.state.data || state !== 'Active' ? false : POLL_MS),
  });

  const power = useQuery({
    queryKey: [...queryKeys.votingPower(address ?? ''), proposal.snapshot],
    queryFn: () =>
      publicClient.readContract({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName: 'getVotes',
        args: [address as `0x${string}`, BigInt(proposal.snapshot)],
      }),
    enabled: !!address && state !== 'Pending',
  });

  const mine = useQuery({
    queryKey: queryKeys.myVote(proposalId, user?.id),
    queryFn: async () => getMyVote(proposalId, await requireIdentityToken()),
    enabled: authenticated,
  });

  // A signed vote survives a reload, even if the backend loses or hides it.
  useEffect(() => {
    if (!address) return;
    const saved = parseSignedVote(window.localStorage.getItem(storageKey(proposalId, address)) ?? '');
    if (saved) setSigned(saved);
  }, [address, proposalId]);

  const held = discarded ? null : (mine.data?.signature ? mine.data : null);
  const pending = signed ?? held;
  const hasPending = pending !== null;

  // The clock starts as soon as there is a signature waiting, wherever it came from.
  useEffect(() => {
    if (hasPending && waitingSince === null) setWaitingSince(Date.now());
  }, [hasPending, waitingSince]);

  useEffect(() => {
    if (waitingSince === null || landed.data) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waitingSince, landed.data]);

  const cast = useMutation({
    mutationFn: async (support: 0 | 1 | 2) => {
      const voter = address as `0x${string}`;
      const nonce = await publicClient.readContract({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName: 'nonces',
        args: [voter],
      });
      const label = SUPPORT_LABELS[support];
      const { signature } = await signTypedData(
        ballotTypedData(CHAIN.id, GOVERNOR_ADDRESS, {
          proposalId,
          support,
          voter,
          nonce: nonce.toString(),
        }),
        {
          address: voter,
          uiOptions: {
            showWalletUIs: true,
            title: `Vote ${label}`,
            description: `You are voting ${label.toUpperCase()} on "${title}".`,
            buttonText: `Sign: ${label}`,
          },
        },
      );
      const vote: SignedVote = { proposalId, voter, support, signature: signature as `0x${string}` };
      // Keep the signature before asking the relay, so a refusal loses nothing.
      window.localStorage.setItem(storageKey(proposalId, voter), JSON.stringify(vote));
      setSigned(vote);
      setWaitingSince(Date.now());
      try {
        await relayVote(
          { proposalId, support, signature: vote.signature },
          await requireIdentityToken(),
        );
      } catch (error) {
        if (isVotePending(error)) {
          // Ballot nonces are sequential: submitting this one by hand would cancel the
          // earlier vote, so forget it and show whatever was signed before.
          window.localStorage.removeItem(storageKey(proposalId, voter));
          setSigned(null);
          setChoice(null);
          setWaitingSince(null);
          setDiscarded(false);
        }
        throw error;
      }
    },
  });

  const submitMyself = useMutation({
    mutationFn: async (vote: SignedVote) => {
      await sendTx({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName: 'castVoteBySig',
        args: [BigInt(vote.proposalId), vote.support, vote.voter, vote.signature],
        description: `Submit your ${SUPPORT_LABELS[vote.support]} vote on "${title}" and pay the gas yourself.`,
      });
      await landed.refetch();
    },
  });

  const wrap = (children: React.ReactNode) => (
    <section aria-label="Your vote" className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-base font-medium text-content">Your vote</h2>
      {children}
    </section>
  );
  const note = (text: string) => wrap(<p className="text-sm text-content-secondary">{text}</p>);

  if (!authenticated) {
    return wrap(
      <button type="button" onClick={login} className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas">
        Sign in to vote
      </button>,
    );
  }
  if (landed.data) {
    // No choice is named: a signature held here may not be the one that was mined.
    return wrap(
      <p role="status" className="text-sm text-status-pos">
        Your vote is on-chain. Checked directly against the chain.
      </p>,
    );
  }

  if (pending && state === 'Active') {
    const relayError = isVotePending(cast.error) ? null : cast.error;
    const relayFailed = !!relayError || (!discarded && mine.data?.status === 'FAILED');
    const overdue = waitingSince !== null && now - waitingSince >= LANDING_TIMEOUT_MS;
    const payload = JSON.stringify({
      proposalId: pending.proposalId,
      voter: pending.voter,
      support: pending.support,
      signature: pending.signature,
    });
    return wrap(
      <>
        <p role="status" className="text-sm text-content">
          Signed {SUPPORT_LABELS[pending.support]}. It is not on-chain yet.
        </p>
        {relayFailed || overdue ? (
          <div role="alert" className="space-y-3 rounded-lg bg-status-warn-bg p-3 text-sm text-status-warn">
            <p>
              Your vote hasn&apos;t landed. Have an officer submit it: send them the signed vote
              below. They can&apos;t change your choice. You can also submit it yourself if your
              wallet has a little ETH.
              {relayError && ` The relay said: ${txErrorMessage(relayError)}`}
              {!discarded && mine.data?.failureReason && ` The relay said: ${mine.data.failureReason}`}
            </p>
            <textarea
              readOnly
              aria-label="Signed vote"
              value={payload}
              rows={4}
              className="w-full rounded border border-line bg-canvas p-2 font-mono text-xs text-content"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(payload)}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-content"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => submitMyself.mutate(pending)}
                disabled={submitMyself.isPending}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-content disabled:opacity-50"
              >
                {submitMyself.isPending ? 'Submitting…' : 'Submit it myself'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (address) window.localStorage.removeItem(storageKey(proposalId, address));
                  setSigned(null);
                  setDiscarded(true);
                  setChoice(null);
                  setWaitingSince(null);
                  cast.reset();
                }}
                className="px-2 text-xs underline"
              >
                Sign again
              </button>
            </div>
            {submitMyself.error && <p>{txErrorMessage(submitMyself.error)}</p>}
          </div>
        ) : (
          <p className="text-xs text-content-secondary">Checking the chain…</p>
        )}
      </>,
    );
  }

  if (state === 'Pending') {
    return note(`Voting opens ${new Date(proposal.snapshot * 1000).toLocaleString('en-US')}.`);
  }
  if (state !== 'Active') return note('Voting has ended.');
  if (power.data === 0n) {
    return note('You had no Rep when this vote was snapshotted, so you can’t vote on it.');
  }

  return wrap(
    <>
      <p className="text-sm text-content-secondary">
        Voting is free. Your weight, fixed at the snapshot:{' '}
        <span className="font-mono text-content">{formatRep(power.data)} Rep</span>
      </p>
      {choice === null ? (
        <div className="flex gap-2">
          {CHOICES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setChoice(value)}
              disabled={power.data === undefined || !address}
              className="flex-1 rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-content hover:bg-raised disabled:opacity-50"
            >
              {SUPPORT_LABELS[value]}
            </button>
          ))}
        </div>
      ) : (
        <div role="group" aria-label="Confirm vote" className="space-y-3 rounded-lg border border-line p-4">
          <p className="text-sm text-content">
            You are voting <b>{SUPPORT_LABELS[choice].toUpperCase()}</b> on <b>{title}</b>. A vote
            can&apos;t be changed once it is on-chain.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => cast.mutate(choice)}
              disabled={cast.isPending}
              className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
            >
              {cast.isPending ? 'Signing…' : 'Sign vote'}
            </button>
            <button type="button" onClick={() => setChoice(null)} className="px-3 text-sm text-content-secondary">
              Back
            </button>
          </div>
        </div>
      )}
      {cast.error && (
        <p role="alert" className="text-sm text-status-neg">
          {txErrorMessage(cast.error)}
        </p>
      )}
    </>,
  );
}
