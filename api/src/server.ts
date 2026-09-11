import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 32 * 1024 * 1024, // scanned papers are large
  });

  // Restricted to the deployed frontend origin. Never a wildcard.
  await app.register(cors, { origin: config.webOrigin, credentials: true });

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
