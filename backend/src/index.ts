import 'dotenv/config';
import { createApp } from './app';
import { startMintWorker } from './jobs/mint.job';
import logger from './lib/logger';
import { adoptUnscopedSessions } from './lib/session';

const required = [
  'DATABASE_URL',
  'REDIS_URL',
  'ALCHEMY_API_KEY',
  'CONTRACT_ADDRESS',
  'RELAY_PRIVATE_KEY',
  'ADMIN_SIGNER_PRIVATE_KEY',
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'CORS_ORIGINS',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    logger.error({ msg: `Missing required environment variable: ${key}` });
    process.exit(1);
  }
}

// Optional, but a production deploy without it publishes relative art and badge URLs.
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_API_URL) {
  logger.warn({ msg: 'PUBLIC_API_URL is unset: art and badge URLs will be relative' });
}

const app = createApp();

const PORT = parseInt(process.env.PORT ?? '3001');

// Sessions must be scoped to the registry before any request looks one up.
adoptUnscopedSessions()
  .then(() => {
    app.listen(PORT, () => {
      logger.info({ msg: `Backend listening on port ${PORT}` });
      startMintWorker();
    });
  })
  .catch((err: Error) => {
    logger.error({ msg: 'Startup failed', err: err.message });
    process.exit(1);
  });

export default app;
