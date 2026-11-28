import type { Session } from '@prisma/client';
import { currentRegistry } from './session';

/** A session as the API returns it to officers. */
export function serializeSession(s: Session) {
  return {
    id: s.id,
    sessionId: s.sessionIdOnchain,
    registryAddress: s.registryAddress,
    isCurrentRegistry: s.registryAddress === currentRegistry(),
    name: s.name,
    date: s.date.toISOString(),
    semester: s.semester,
    createdBy: s.createdBy,
    txHash: s.txHash,
    closeTxHash: s.closeTxHash,
    onchainStatus: s.onchainStatus,
    closedAt: s.closedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    maxAttendees: s.maxAttendees,
    metadataCid: s.metadataCid,
    repStatus: s.repStatus,
    closedBy: s.closedBy,
    confirmedBy: s.confirmedBy,
    recognizedAt: s.recognizedAt?.toISOString() ?? null,
    listedCount: s.attendees.length,
    creditCursor: s.creditCursor,
  };
}
