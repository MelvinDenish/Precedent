import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_PREFIX } from '@precedent/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { registerErrorHandler } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCorpusRoutes } from './routes/corpus.js';
import { registerUploadRoute } from './routes/upload.js';
import { attachDeadLetterListeners } from './queue/dead-letter.js';
import { allQueues, closeQueues } from './queue/index.js';
import { registerProgressSocket } from './ws/progress.js';

export interface BuildOptions {
  /**
   * Background Redis consumers: the dead-letter listeners and the progress
   * subscriber. Each holds its own blocking connection, so the test suite
   * builds servers without them and exercises the hub directly.
   */
  background?: boolean;
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const background = options.background ?? true;

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 32 * 1024 * 1024, // scanned papers are large
  });

  // Restricted to the deployed frontend origin. Never a wildcard.
  await app.register(cors, { origin: config.webOrigin, credentials: true });

  // Secret comes from config, which throws at import time if it is unset.
  // There is deliberately no fallback: a server that boots with a default
  // JWT secret is a server that ships one.
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  });

  await app.register(multipart, {
    limits: { fileSize: config.upload.maxBytes, files: 1 },
  });

  // A global floor. Upload and tutor routes tighten this per user, because
  // both cost real money downstream -- vision extraction and Groq tokens.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(websocket);

  registerErrorHandler(app);

  /**
   * Neon and other serverless Postgres tiers suspend idle compute, so the
   * first request after a sleep is slow. A keep-alive ping against this
   * endpoint avoids surprising a visitor with a cold start.
   *
   * Unprefixed as well as prefixed: the deployment's health check points at
   * /health, while the frontend composes API_PREFIX + ROUTES.health.
   */
  const health = async (): Promise<{ ok: true; dbLatencyMs: number }> => {
    const started = Date.now();
    await pool.query('SELECT 1');
    return { ok: true, dbLatencyMs: Date.now() - started };
  };
  app.get('/health', health);

  // Everything in the frozen ROUTES map hangs off API_PREFIX; the web client
  // composes `${API_PREFIX}${ROUTES.x}` rather than hardcoding paths.
  await app.register(
    async (api) => {
      api.get('/health', health);
      registerAuthRoutes(api);
      registerUploadRoute(api);
      registerCorpusRoutes(api);
      const progress = registerProgressSocket(api, api.log, { subscribe: background });
      api.addHook('onClose', progress.close);
    },
    { prefix: API_PREFIX },
  );

  if (background) {
    // Instantiated eagerly so a bad REDIS_URL fails at boot rather than on
    // the first student's upload.
    allQueues();
    const detach = attachDeadLetterListeners(app.log);
    app.addHook('onClose', async () => {
      await detach();
      await closeQueues();
    });
  }

  return app;
}
