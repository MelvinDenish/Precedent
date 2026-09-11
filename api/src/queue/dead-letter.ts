/**
 * Dead-letter handling: a failed job a human could fix becomes a review_queue
 * row with kind = 'dlq', not a line in a log nobody reads.
 *
 * The API hosts these listeners rather than the worker because the API is the
 * process that already owns the review queue and the progress socket, and
 * because a worker that died mid-job is in no position to report itself.
 */
import { Job, QueueEvents } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { QUEUES, type QueueName } from '@precedent/shared';
import { pool } from '../db.js';
import { queue, redis } from './index.js';
import type { DlqPayload } from '../types.js';

/**
 * review_queue.subject_id is NOT NULL with an FK, but the frozen job bodies
 * mostly do not carry a subject: ExtractJob has only {paperId, blobUrl},
 * EmbedJob only {questionIds}. Each shape is resolved back to its subject
 * through the graph.
 */
export async function resolveSubjectId(data: unknown): Promise<string | null> {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  if (typeof d['subjectId'] === 'string' && d['subjectId']) return d['subjectId'];

  const first = (v: unknown): string | null =>
    Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;

  const paperId = typeof d['paperId'] === 'string' ? d['paperId'] : null;
  if (paperId) {
    const { rows } = await pool.query<{ subject_id: string }>(
      'SELECT subject_id FROM papers WHERE paper_id = $1',
      [paperId],
    );
    return rows[0] ? String(rows[0].subject_id) : null;
  }

  const questionId =
    (typeof d['questionId'] === 'string' ? d['questionId'] : null) ?? first(d['questionIds']);
  if (questionId) {
    const { rows } = await pool.query<{ subject_id: string }>(
      `SELECT p.subject_id
         FROM questions q
         JOIN papers p ON p.paper_id = q.paper_id
        WHERE q.question_id = $1`,
      [questionId],
    );
    return rows[0] ? String(rows[0].subject_id) : null;
  }

  const clusterId = first(d['clusterIds']);
  if (clusterId) {
    const { rows } = await pool.query<{ subject_id: string }>(
      'SELECT subject_id FROM clusters WHERE cluster_id = $1',
      [clusterId],
    );
    return rows[0] ? String(rows[0].subject_id) : null;
  }

  return null;
}

export async function recordDeadLetter(
  subjectId: string,
  payload: DlqPayload,
): Promise<string | null> {
  const { rows } = await pool.query<{ review_id: string }>(
    `INSERT INTO review_queue (subject_id, kind, payload, status)
     VALUES ($1, 'dlq', $2::jsonb, 'open')
     RETURNING review_id`,
    [subjectId, JSON.stringify(payload)],
  );
  return rows[0] ? String(rows[0].review_id) : null;
}

/**
 * True only on the terminal failure. BullMQ emits `failed` on EVERY attempt,
 * so without this gate one exhausted job would produce `attempts` review rows
 * and bury the queue a human is meant to be working through.
 */
function isExhausted(job: Job): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

export async function handleFailure(
  queueName: QueueName,
  jobId: string,
  failedReason: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const job = await Job.fromId(queue(queueName), jobId);
  if (!job || !isExhausted(job)) return;

  const subjectId = await resolveSubjectId(job.data);
  const payload: DlqPayload = {
    queue: queueName,
    jobId,
    jobName: job.name,
    attemptsMade: job.attemptsMade,
    failedReason,
    data: job.data,
    failedAt: new Date().toISOString(),
  };

  if (!subjectId) {
    // The one outcome the requirement forbids: a dead job with nowhere to be
    // filed. Loud, at error level, with the whole body, because the review
    // queue cannot hold it and this log line is now the only record.
    log.error(
      { payload },
      'dead-letter job could not be attributed to a subject and is NOT in the review queue',
    );
    return;
  }

  const reviewId = await recordDeadLetter(subjectId, payload);
  log.warn({ queue: queueName, jobId, reviewId, failedReason }, 'job dead-lettered to review queue');
}

/**
 * One QueueEvents stream per queue. Returns a closer the server calls on
 * shutdown; these hold blocking Redis connections.
 */
export function attachDeadLetterListeners(log: FastifyBaseLogger): () => Promise<void> {
  const streams = Object.values(QUEUES).map((name) => {
    const events = new QueueEvents(name, { connection: redis().duplicate() });
    events.on('failed', ({ jobId, failedReason }) => {
      handleFailure(name, jobId, failedReason ?? 'unknown', log).catch((err) => {
        log.error({ err, queue: name, jobId }, 'dead-letter handler threw');
      });
    });
    return events;
  });

  return async () => {
    await Promise.all(streams.map((s) => s.close()));
  };
}
