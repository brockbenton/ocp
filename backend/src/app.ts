// Patches Express 4 to forward async handler rejections to the error middleware
// (Express 4 does not do this natively). Must load before routers.
import 'express-async-errors';
import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import sessionsRouter from './routes/sessions';
import checkInRouter from './routes/check-in';
import adminRouter from './routes/admin';
import membersRouter from './routes/members';
import assetsRouter from './routes/art';
import governanceRouter from './routes/governance';
import clubRouter from './routes/club';
import logger from './lib/logger';

/**
 * Parses CORS_ORIGINS (comma-separated) into an exact-match allowlist. A trailing
 * slash is dropped because browsers never send one in the Origin header.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsOptions(): CorsOptions {
  return {
    // An empty list allows no cross-origin caller at all, never "any origin".
    origin: parseCorsOrigins(process.env.CORS_ORIGINS),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  };
}

/** Builds the Express app (no listener / worker) so tests can import it directly. */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      // The API serves JSON and standalone SVG images, never HTML.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      frameguard: { action: 'deny' },
    }),
  );
  app.use(cors(corsOptions()));
  app.use(express.json());

  app.use('/api/v1/sessions', sessionsRouter);
  app.use('/api/v1/check-in', checkInRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/members', membersRouter);
  app.use('/api/v1/governance', governanceRouter);
  app.use('/api/v1/club', clubRouter);
  app.use('/api/v1', assetsRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ msg: 'Unhandled error', err: err.message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}
