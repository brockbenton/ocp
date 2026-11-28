/**
 * Officer alerts: sessions that look anomalous when closed, and sessions left open too
 * long. Alerts go to the log and, when ALERT_WEBHOOK_URL is set, to a chat webhook. The
 * dashboard shows the same facts, so a missing webhook hides nothing.
 */
import { settings } from '../lib/config';
import { currentRegistry } from '../lib/session';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { flagsFor, pendingSessions } from './review.service';

const HOUR_MS = 3_600_000;

/** @returns false if a configured webhook rejected the alert, so it should be retried. */
export async function notifyOfficers(message: string): Promise<boolean> {
  logger.warn({ msg: 'Officer alert', alert: message });
  const url = settings.alertWebhookUrl;
  if (!url) return true;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` for Slack-style webhooks, `content` for Discord.
      body: JSON.stringify({ text: message, content: message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) logger.error({ msg: 'Alert webhook rejected the message', status: response.status });
    return response.ok;
  } catch (err) {
    logger.error({ msg: 'Alert webhook failed', err: (err as Error).message });
    return false;
  }
}

/** Alerts once for each pending session that has anomaly flags. */
export async function alertAnomalies(): Promise<void> {
  for (const session of (await pendingSessions()).filter((s) => !s.alertedAt)) {
    const flags = await flagsFor(session);
    if (flags.length > 0) {
      const sent = await notifyOfficers(
        `Review needed before confirming "${session.name}" (session ${session.sessionIdOnchain}): ` +
          flags.map((f) => f.message).join('; '),
      );
      if (!sent) continue;
    }
    await prisma.session.update({ where: { id: session.id }, data: { alertedAt: new Date() } });
  }
}

/** A nudge only: sessions are never closed automatically. */
export async function warnOpenSessions(now: number = Date.now()): Promise<void> {
  const hours = settings.openSessionWarnHours;
  const stale = await prisma.session.findMany({
    where: {
      registryAddress: currentRegistry(),
      onchainStatus: 'CONFIRMED',
      closedAt: null,
      openWarnedAt: null,
      createdAt: { lt: new Date(now - hours * HOUR_MS) },
    },
  });
  for (const session of stale) {
    const sent = await notifyOfficers(
      `"${session.name}" (session ${session.sessionIdOnchain}) has been open for more than ${hours} hours. Close it?`,
    );
    if (sent) {
      await prisma.session.update({ where: { id: session.id }, data: { openWarnedAt: new Date(now) } });
    }
  }
}
