'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { recoverTypedDataAddress } from 'viem';
import { GOVERNOR_ABI } from '@/lib/abi';
import { CHAIN, GOVERNOR_ADDRESS } from '@/lib/constants';
import { publicClient } from '@/lib/chain';
import { getProposal } from '@/lib/api/governance';
import { ballotTypedData } from '@/lib/typedData';
import { matchesProposalId, proposalTitle } from '@/lib/proposals';
import { txErrorMessage } from '@/lib/txError';
import { parseSignedVote, SUPPORT_LABELS } from '@/lib/votePayload';
import { shortenAddress } from '@/lib/address';
import { useWalletTx } from '@/hooks/useWalletTx';
import type { SignedVote } from '@/types';

interface Checked {
  vote: SignedVote;
  title: string;
}

/** Throws unless the pasted vote is genuine and not yet cast. */
async function check(text: string): Promise<Checked> {
  const vote = parseSignedVote(text);
  if (!vote) throw new Error('That isn’t a signed vote. Paste exactly what the member sent.');
  const args = [BigInt(vote.proposalId), vote.voter as `0x${string}`] as const;
  const [hasVoted, nonce, proposal] = await Promise.all([
    publicClient.readContract({ address: GOVERNOR_ADDRESS, abi: GOVERNOR_ABI, functionName: 'hasVoted', args }),
    publicClient.readContract({
      address: GOVERNOR_ADDRESS,
      abi: GOVERNOR_ABI,
      functionName: 'nonces',
      args: [args[1]],
    }),
    getProposal(vote.proposalId),
  ]);
  if (hasVoted) throw new Error('This member’s vote is already on-chain.');
  const typed = ballotTypedData(CHAIN.id, GOVERNOR_ADDRESS, {
    proposalId: vote.proposalId,
    support: vote.support,
    voter: vote.voter,
    nonce: nonce.toString(),
  });
  const signer = await recoverTypedDataAddress({
    ...(typed as unknown as Parameters<typeof recoverTypedDataAddress>[0]),
    signature: vote.signature,
  });
  if (signer.toLowerCase() !== vote.voter.toLowerCase()) {
    throw new Error('The signature doesn’t match this member and choice. Ask them to sign again.');
  }
  if (!matchesProposalId(proposal)) throw new Error('The proposal details don’t match its on-chain id.');
  return { vote, title: proposalTitle(proposal.description) };
}

/** The fallback if the relay is down or censoring: an officer submits a member's vote. */
export default function SubmitSignedVote() {
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const sendTx = useWalletTx();

  const verify = useMutation({ mutationFn: check, onMutate: () => setDone(false) });
  const submit = useMutation({
    mutationFn: async ({ vote, title }: Checked) => {
      await sendTx({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName: 'castVoteBySig',
        args: [BigInt(vote.proposalId), vote.support, vote.voter, vote.signature],
        description: `Submit ${shortenAddress(vote.voter)}'s ${SUPPORT_LABELS[vote.support]} vote on "${title}".`,
      });
    },
    onSuccess: () => {
      setDone(true);
      setText('');
      verify.reset();
    },
  });

  const error = verify.error ?? submit.error;
  return (
    <details className="rounded-xl border border-line bg-surface p-5">
      <summary className="cursor-pointer text-sm font-medium text-content">
        Submit a member&apos;s signed vote
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-content-secondary">
          If a member&apos;s vote hasn&apos;t landed, paste what they sent. You pay the gas; the
          signature fixes their choice.
        </p>
        <textarea
          aria-label="Signed vote to submit"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            verify.reset();
            submit.reset();
          }}
          rows={4}
          className="w-full rounded-lg border border-line bg-canvas p-3 font-mono text-xs text-content"
        />
        {verify.data ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-content">
              <span className="font-mono">{shortenAddress(verify.data.vote.voter)}</span> votes{' '}
              <b>{SUPPORT_LABELS[verify.data.vote.support]}</b> on <b>{verify.data.title}</b>
            </p>
            <button
              type="button"
              onClick={() => submit.mutate(verify.data)}
              disabled={submit.isPending}
              className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
            >
              {submit.isPending ? 'Submitting…' : 'Submit this vote'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => verify.mutate(text)}
            disabled={!text.trim() || verify.isPending}
            className="rounded-lg border border-line-strong px-4 py-2 text-sm text-content disabled:opacity-50"
          >
            {verify.isPending ? 'Checking…' : 'Check vote'}
          </button>
        )}
        {error && (
          <p role="alert" className="text-sm text-status-neg">
            {txErrorMessage(error)}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-status-pos">
            The vote is on-chain.
          </p>
        )}
      </div>
    </details>
  );
}
