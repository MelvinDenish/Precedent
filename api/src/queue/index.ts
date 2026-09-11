/**
 * BullMQ queue registry.
 *
 * One Queue per entry in the frozen QUEUES map. The API only ever ENQUEUES:
 * it never runs a processor, because a request that blocks on a free-tier LLM
 * call inherits its rate limits, its latency and its failures.
 */
import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUES, type QueueName } from '@precedent/shared';
import { config } from '../config.js';

/**
 * maxRetriesPerRequest must be null for BullMQ: its blocking commands sit on
 * the connection for a long time and ioredis would otherwise abort them.
 */
export function createRedis(): IORedis {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

let connection: IORedis | null = null;

export function redis(): IORedis {
  connection ??= createRedis();
  return connection;
}

/**
 * Retry policy for every queue.
 *
 * Exponential backoff PLUS jitter, capped attempts, then dead-letter. The
 * jitter is the part that matters under a provider outage: without it, every
 * job failed by the same outage retries on the same schedule and rebuilds the
 * spike that caused the failure. bullmq's built-in exponential strategy takes
 * a jitter fraction directly, so this needs no custom strategy -- which also
 * means it cannot break: a `custom` backoff type whose strategy the worker
 * forgot to register throws at retry time and silently disables retries
 * across all six queues.
 */
export const defaultJobOptions: JobsOptions = {
  attempts: config.queue.attempts,
  backoff: {
    type: 'exponential',
    delay: config.queue.backoffDelayMs,
    jitter: config.queue.backoffJitter,
  },
  removeOnComplete: { age: 3600, count: 1000 },
  // Failed jobs are NOT removed: the dead-letter handler reads the job body
  // back to build a review_queue row, and a human may need to inspect it.
  removeOnFail: false,
};

const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis(), defaultJobOptions });
    queues.set(name, q);
  }
  return q;
}

/** Instantiates all six up front so a bad Redis URL fails at boot, not at first upload. */
export function allQueues(): Queue[] {
  return Object.values(QUEUES).map((name) => queue(name));
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
