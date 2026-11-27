import { Response } from 'express';
import type { Session } from '@prisma/client';
import prisma from './prisma';
import logger from './logger';

/** Sessions with a close in flight (on-chain ids); check-ins are refused until it settles. */
export const closingSessions = new Set<string>();

// August is the first month of the fall semester; everything before it is spring.
const FALL_START_MONTH = 7;

/** The semester a date falls in: Aug 1 to Dec 31 is Fall, Jan 1 to Jul 31 is Spring. */
export function semesterFor(date: Date): string {
  const season = date.getUTCMonth() >= FALL_START_MONTH ? 'Fall' : 'Spring';
  return `${season} ${date.getUTCFullYear()}`;
}

/** The configured registry, lowercase, as stored on session rows. */
export function currentRegistry(): string {
  return (process.env.CONTRACT_ADDRESS ?? '').toLowerCase();
}

/**
 * Unique key of a session on the configured registry. An on-chain id alone does not
 * identify a session, so every lookup goes through this (#56).
 */
export function sessionKey(sessionIdOnchain: string) {
  return {
    registryAddress_sessionIdOnchain: { registryAddress: currentRegistry(), sessionIdOnchain },
  };
}

/**
 * Assigns sessions recorded before they carried a registry to the configured one.
 * Runs at startup; those rows were all created against the registry in use then.
 */
export async function adoptUnscopedSessions(): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { registryAddress: '' },
    data: { registryAddress: currentRegistry() },
  });
  if (count > 0) logger.info({ msg: 'Scoped existing sessions to the registry', count, registry: currentRegistry() });
  return count;
}

/** Loads a session by on-chain id, sending the 404 response when it does not exist. */
export async function findSessionOr404(
  sessionIdOnchain: string,
  res: Response,
): Promise<Session | null> {
  const session = await prisma.session.findUnique({ where: sessionKey(sessionIdOnchain) });
  if (!session) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
  }
  return session;
}
