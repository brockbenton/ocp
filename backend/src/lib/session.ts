import { Response } from 'express';
import type { Session } from '@prisma/client';
import prisma from './prisma';
import logger from './logger';

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
export function sessionKey(sessionIdOnchain: string, registry: string = currentRegistry()) {
  return {
    registryAddress_sessionIdOnchain: { registryAddress: registry.toLowerCase(), sessionIdOnchain },
  };
}

/**
 * Assigns sessions recorded before they carried a registry to the legacy registry, which
 * is where they were all created. Runs at startup, and refuses to guess: assigning them
 * to the current registry would make old meetings look like open ones.
 */
export async function adoptUnscopedSessions(): Promise<number> {
  const where = { registryAddress: '' };
  if ((await prisma.session.count({ where })) === 0) return 0;

  const legacy = (process.env.LEGACY_REGISTRY_ADDRESS ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(legacy)) {
    throw new Error('Set LEGACY_REGISTRY_ADDRESS: some sessions are not assigned to a registry yet');
  }
  const { count } = await prisma.session.updateMany({ where, data: { registryAddress: legacy } });
  logger.info({ msg: 'Scoped existing sessions to the legacy registry', count, registry: legacy });
  return count;
}

/**
 * Loads a session by registry and on-chain id, sending the 404 response when it does not
 * exist. `registry` reads history from an earlier deployment; it defaults to the current one.
 */
export async function findSessionOr404(
  sessionIdOnchain: string,
  res: Response,
  registry?: string,
): Promise<Session | null> {
  const session = await prisma.session.findUnique({ where: sessionKey(sessionIdOnchain, registry) });
  if (!session) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
  }
  return session;
}
