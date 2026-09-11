import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import { registerErrorHandler } from './errors.js';

export async function buildServer(): Promise<FastifyInstance> {
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
    limits: { fileSize: 32 * 1024 * 1024, files: 1 },
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
   */
  app.get('/health', async () => {
    const started = Date.now();
    await pool.query('SELECT 1');
    return { ok: true, dbLatencyMs: Date.now() - started };
  });

  return app;
}
