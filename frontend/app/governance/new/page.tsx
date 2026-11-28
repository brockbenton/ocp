'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { useMutation, useQuery } from '@tanstack/react-query';
import WalletBalance from '@/components/shared/WalletBalance';
import { GOVERNOR_ABI, REP_ABI } from '@/lib/abi';
import { GOVERNOR_ADDRESS, REP_ADDRESS } from '@/lib/constants';
import { publicClient } from '@/lib/chain';
import { queryKeys } from '@/lib/api/queryKeys';
import {
  buildActions,
  describeActions,
  PARAMETERS,
  TEMPLATES,
  type ProposalActions,
  type TemplateKey,
} from '@/lib/proposals';
import { formatRep } from '@/lib/rep';
import { txErrorMessage } from '@/lib/txError';
import { useClub } from '@/hooks/useClub';
import { useEmbeddedAddress } from '@/hooks/useProfile';
import { useWalletTx } from '@/hooks/useWalletTx';

const INPUT =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-content focus:outline-none focus:ring-2 focus:ring-green';

interface Draft {
  actions: ProposalActions;
  description: string;
}

export default function NewProposalPage() {
  const router = useRouter();
  const { authenticated, login } = usePrivy();
  const address = useEmbeddedAddress();
  const { data: club } = useClub();
  const sendTx = useWalletTx();
  const [template, setTemplate] = useState<TemplateKey>('appoint');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [input, setInput] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');

  const { data: power } = useQuery({
    queryKey: queryKeys.votingPower(address ?? ''),
    queryFn: () =>
      publicClient.readContract({
        address: REP_ADDRESS,
        abi: REP_ABI,
        functionName: 'getVotes',
        args: [address as `0x${string}`],
      }),
    enabled: !!address,
  });
  const short = !!club && power !== undefined && power < BigInt(club.proposalThreshold);

  const propose = useMutation({
    mutationFn: async ({ actions, description }: Draft) =>
      sendTx({
        address: GOVERNOR_ADDRESS,
        abi: GOVERNOR_ABI,
        functionName: 'propose',
        args: [actions.targets, actions.values.map(BigInt), actions.calldatas, description],
        description: `Propose "${description.split('\n')[0]}".`,
      }),
    onSuccess: () => router.push('/governance'),
  });

  function review(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (!title.trim()) throw new Error('Give the proposal a title.');
      const actions = buildActions(template, input);
      const description = details.trim() ? `${title.trim()}\n\n${details.trim()}` : title.trim();
      setDraft({ actions, description });
      setFormError('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Check the fields and try again.');
    }
  }

  return (
    <>
      <Link href="/governance" className="block w-fit text-sm text-content-secondary hover:text-content">
        ← All proposals
      </Link>
      <h1 className="text-[26px] font-medium leading-8 text-content">New proposal</h1>

      {!authenticated ? (
        <button type="button" onClick={login} className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas">
          Sign in to propose
        </button>
      ) : (
        <div className="space-y-5 rounded-xl border border-line bg-surface p-5">
          <div className="space-y-1">
            <p className="text-sm text-content-secondary">
              Proposing costs gas and needs{' '}
              {club ? `${formatRep(club.proposalThreshold)} Rep` : 'enough Rep'}. You have{' '}
              <span className="font-mono text-content">{formatRep(power)}</span>.
            </p>
            {short && (
              <p role="status" className="text-sm text-status-warn">
                You are below the threshold, so this would be rejected.
              </p>
            )}
            <WalletBalance />
          </div>

          {!draft ? (
            <form onSubmit={review} className="space-y-4">
              <label className="block space-y-1 text-sm font-medium text-content">
                Type
                <select
                  value={template}
                  onChange={(e) => {
                    setTemplate(e.target.value as TemplateKey);
                    setInput({});
                  }}
                  className={INPUT}
                >
                  {Object.entries(TEMPLATES).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm font-medium text-content">
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={INPUT} required />
              </label>
              <label className="block space-y-1 text-sm font-medium text-content">
                Details (optional)
                <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} className={INPUT} />
              </label>
              {TEMPLATES[template].fields.map((field) => (
                <label key={field.name} className="block space-y-1 text-sm font-medium text-content">
                  {field.label}
                  {field.kind === 'parameter' ? (
                    <select
                      value={input[field.name] ?? ''}
                      onChange={(e) => setInput({ ...input, [field.name]: e.target.value })}
                      className={INPUT}
                    >
                      <option value="">Choose…</option>
                      {Object.entries(PARAMETERS).map(([key, parameter]) => (
                        <option key={key} value={key}>
                          {parameter.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={input[field.name] ?? ''}
                      onChange={(e) => setInput({ ...input, [field.name]: e.target.value })}
                      className={`${INPUT} ${field.kind === 'address' || field.kind === 'hex' ? 'font-mono' : ''}`}
                      inputMode={field.kind === 'number' || field.kind === 'rep' ? 'decimal' : undefined}
                    />
                  )}
                </label>
              ))}
              {formError && (
                <p role="alert" className="text-sm text-status-neg">
                  {formError}
                </p>
              )}
              <button type="submit" className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas">
                Review
              </button>
            </form>
          ) : (
            <div aria-label="Review before signing" className="space-y-4">
              <p className="whitespace-pre-wrap text-sm text-content">{draft.description}</p>
              <ol className="list-decimal space-y-2 pl-5">
                {describeActions(draft.actions).map((action, i) => (
                  <li key={i} className={`break-all text-sm ${action.understood ? 'text-content' : 'text-status-warn'}`}>
                    {action.text}
                  </li>
                ))}
              </ol>
              <p className="text-xs text-content-secondary">
                Out-of-range settings are rejected when the proposal executes.
              </p>
              {propose.error && (
                <p role="alert" className="text-sm text-status-neg">
                  {txErrorMessage(propose.error)}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => propose.mutate(draft)}
                  disabled={propose.isPending}
                  className="rounded-lg bg-content px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
                >
                  {propose.isPending ? 'Waiting for the chain…' : 'Sign and propose'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    propose.reset();
                    setDraft(null);
                  }}
                  className="px-3 text-sm text-content-secondary"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
