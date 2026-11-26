import { Badge } from '@/components/ui';
import type { BadgeProps } from '@/components/ui';
import type { ProposalState } from '@/types';

const TONE: Record<ProposalState, BadgeProps['tone']> = {
  Pending: 'neutral',
  Active: 'info',
  Canceled: 'neg',
  Defeated: 'neg',
  Succeeded: 'pos',
  Queued: 'warn',
  Expired: 'neg',
  Executed: 'pos',
};

export default function ProposalStateBadge({ state }: { state: ProposalState }) {
  return <Badge tone={TONE[state]}>{state}</Badge>;
}
