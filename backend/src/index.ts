import 'dotenv/config';
import logger from './lib/logger';
import { missingEnv } from './lib/config';

const missing = missingEnv();
if (missing.length > 0) {
  logger.error({ msg: `Missing required environment variables: ${missing.join(', ')}` });
  process.exit(1);
}

// Optional, but a production deploy without it publishes relative art and badge URLs.
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_API_URL) {
  logger.warn({ msg: 'PUBLIC_API_URL is unset: art and badge URLs will be relative' });
}

async function main(): Promise<void> {
  // Imported only now: these modules read the variables checked above.
  const { createApp } = await import('./app');
  const { assertKeyRoles } = await import('./lib/keyChecks');
  const { adoptUnscopedSessions } = await import('./lib/session');
  const { startJobs } = await import('./jobs/runner');

  await assertKeyRoles();
  // Sessions must be scoped to a registry before any request looks one up.
  await adoptUnscopedSessions();

  const port = parseInt(process.env.PORT ?? '3001', 10);
  createApp().listen(port, () => {
    logger.info({ msg: `Backend listening on port ${port}` });
    startJobs();
  });
}

main().catch((err: Error) => {
  logger.error({ msg: 'Startup failed', err: err.message });
  process.exit(1);
});
