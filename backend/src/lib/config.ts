import { isAddress, parseGwei } from 'viem';

type Address = `0x${string}`;

/** Variables the server cannot run without. */
export const REQUIRED_ENV = [
  'DATABASE_URL',
  'CONTRACT_ADDRESS',
  'REP_ADDRESS',
  'GOVERNOR_ADDRESS',
  'TIMELOCK_ADDRESS',
  'INDEXER_START_BLOCK',
  'RELAY_PRIVATE_KEY',
  'QR_SIGNER_PRIVATE_KEY',
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'CORS_ORIGINS',
] as const;

/** Names of required variables that are unset; an RPC endpoint is needed in one of two forms. */
export function missingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = REQUIRED_ENV.filter((name) => !env[name]);
  if (!env.RPC_URL && !env.ALCHEMY_API_KEY) missing.push('ALCHEMY_API_KEY (or RPC_URL)');
  for (const name of ['CONTRACT_ADDRESS', 'REP_ADDRESS', 'GOVERNOR_ADDRESS', 'TIMELOCK_ADDRESS']) {
    if (env[name] && !isAddress(env[name], { strict: false })) missing.push(`${name} (not an address)`);
  }
  return missing;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const addresses = {
  get registry() {
    return process.env.CONTRACT_ADDRESS as Address;
  },
  get rep() {
    return process.env.REP_ADDRESS as Address;
  },
  get governor() {
    return process.env.GOVERNOR_ADDRESS as Address;
  },
  get timelock() {
    return process.env.TIMELOCK_ADDRESS as Address;
  },
};

export const settings = {
  /** Blocks a transaction or event must be under before it is treated as final. */
  get confirmations() {
    return positiveInt(process.env.CONFIRMATIONS, 5);
  },
  get indexerStartBlock() {
    return BigInt(process.env.INDEXER_START_BLOCK || '0');
  },
  get indexerBlockChunk() {
    return BigInt(positiveInt(process.env.INDEXER_BLOCK_CHUNK, 2000));
  },
  get indexerPollMs() {
    return positiveInt(process.env.INDEXER_POLL_MS, 5000);
  },
  get relayTickMs() {
    return positiveInt(process.env.RELAY_TICK_MS, 3000);
  },
  /** An unmined transaction older than this is replaced. */
  get relayStuckAfterMs() {
    return positiveInt(process.env.RELAY_STUCK_AFTER_MS, 60_000);
  },
  /** Ceiling on the fee per gas the relay will ever offer. */
  get relayMaxFeePerGas() {
    return parseGwei(process.env.RELAY_MAX_FEE_GWEI || '5');
  },
  get relayMinBalanceEth() {
    return process.env.RELAY_MIN_BALANCE_ETH || '0.005';
  },
  get openSessionWarnHours() {
    return positiveInt(process.env.OPEN_SESSION_WARN_HOURS, 6);
  },
  get alertWebhookUrl() {
    return process.env.ALERT_WEBHOOK_URL || null;
  },
};
