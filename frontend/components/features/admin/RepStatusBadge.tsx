import { Badge } from '@/components/ui';
import type { Session } from '@/types';

/** Where a closed meeting's Rep stands. */
export default function RepStatusBadge({
  session,
}: {
  session: Pick<Session, 'repStatus' | 'creditCursor' | 'listedCount'>;
}) {
  switch (session.repStatus) {
    case 'PENDING':
      return <Badge tone="warn">Rep pending approval</Badge>;
    case 'CONFIRMED':
      return (
        <Badge tone="info">
          Crediting {session.creditCursor}/{session.listedCount}
        </Badge>
      );
    case 'CREDITED':
      return <Badge tone="pos">Rep credited</Badge>;
    case 'REJECTED':
      return <Badge tone="neg">Rep rejected</Badge>;
    default:
      return <Badge>Closed</Badge>;
  }
}
