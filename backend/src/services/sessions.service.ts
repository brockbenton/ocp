import type { Session } from '@prisma/client';
import { currentRegistry, sessionKey } from '../lib/session';
import prisma from '../lib/prisma';
import { getSessionOnChain, getSignOffOnChain } from './onchain.service';

/**
 * Copies one session's current on-chain state into its row, creating the row if needed.
 * The indexer later fills in what only events carry (the attendee list, tx hashes).
 *
 * @param seenBy used as `createdBy` until the indexer records the actual creator.
 * @returns null if the session is not on the registry.
 */
export async function syncSession(sessionIdOnchain: string, seenBy: string): Promise<Session | null> {
  const onchain = await getSessionOnChain(sessionIdOnchain);
  if (!onchain) return null;
  const signOff = await getSignOffOnChain(sessionIdOnchain);

  const mirrored = {
    name: onchain.name,
    date: new Date(Number(onchain.date) * 1000),
    semester: onchain.semester,
    maxAttendees: onchain.maxAttendees,
    metadataCid: onchain.metadataCid || null,
    onchainStatus: 'CONFIRMED' as const,
  };
  const row = await prisma.session.upsert({
    where: sessionKey(sessionIdOnchain),
    create: { registryAddress: currentRegistry(), sessionIdOnchain, createdBy: seenBy, ...mirrored },
    update: mirrored,
  });
  if (signOff.status === 'NONE') return row;

  return prisma.session.update({
    where: { id: row.id },
    data: {
      repStatus: signOff.status,
      closedAt: row.closedAt ?? new Date(),
      closedBy: signOff.closer.toLowerCase(),
      attendeesHash: signOff.attendeesHash,
      creditCursor: signOff.cursor,
      ...(signOff.recognizedAt > 0
        ? {
            confirmedBy: signOff.confirmer.toLowerCase(),
            recognizedAt: new Date(signOff.recognizedAt * 1000),
          }
        : {}),
    },
  });
}
