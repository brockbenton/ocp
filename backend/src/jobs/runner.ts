import { formatEther, parseEther } from 'viem';
import { settings } from '../lib/config';
import logger from '../lib/logger';
import { alertAnomalies, warnOpenSessions } from '../services/alerts.service';
import { indexToHead } from '../services/indexer.service';
import { getRelayBalanceWei, relayAddress } from '../services/onchain.service';
import { relayTick } from '../services/relayWork.service';

const ALERT_INTERVAL_MS = 60_000;
const BALANCE_INTERVAL_MS = 15 * 60_000;

export function isBalanceLow(balanceWei: bigint, minWei: bigint): boolean {
  return balanceWei < minWei;
}

export async function checkRelayBalance(): Promise<void> {
  const balance = await getRelayBalanceWei();
  const minimum = settings.relayMinBalanceEth;
  const details = { relayAddress, balanceEth: formatEther(balance), minEth: minimum };
  if (isBalanceLow(balance, parseEther(minimum))) {
    logger.warn({ msg: 'Relay wallet balance is low: mints and votes may fail', ...details });
  } else {
    logger.info({ msg: 'Relay wallet balance', ...details });
  }
}

/**
 * Runs `job` repeatedly, waiting for each run to finish before scheduling the next, so a
 * slow run never overlaps itself. Failures are logged and retried on the next pass.
 */
export function every(name: string, intervalMs: number, job: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = async () => {
    try {
      await job();
    } catch (err) {
      logger.error({ msg: `Job failed: ${name}`, err: (err as Error).message });
    }
    if (!stopped) timer = setTimeout(() => void run(), intervalMs);
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Starts the one relay sender, the one indexer and the officer alerts. */
export function startJobs(): () => void {
  const stops = [
    every('indexer', settings.indexerPollMs, indexToHead),
    every('relay', settings.relayTickMs, relayTick),
    every('officer-alerts', ALERT_INTERVAL_MS, async () => {
      await alertAnomalies();
      await warnOpenSessions();
    }),
    every('relay-balance', BALANCE_INTERVAL_MS, checkRelayBalance),
  ];
  logger.info({ msg: 'Background jobs started' });
  return () => stops.forEach((stop) => stop());
}
