/**
 * API entrypoint. Stateless and horizontally scalable: all long or expensive
 * work is queued to the worker pool.
 *
 * The API never calls an LLM synchronously, with exactly one exception.
 * A request that blocks on a free-tier LLM call inherits its rate limits,
 * its latency and its failures, so ingestion is queued and reported over
 * WebSocket. The exception is Tutor Chat, which streams over SSE, because a
 * tutor that takes eight seconds to start answering is not a tutor.
 */
import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);

const server = await buildServer();

try {
  await server.listen({ port, host: '0.0.0.0' });
  server.log.info(`api listening on ${port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
