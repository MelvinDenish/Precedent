/**
 * Queue reliability, per-provider rate limiting, blob storage and the
 * progress hub.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Worker } from 'bullmq';
import { QUEUES, type IngestProgressEvent } from '@precedent/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { LocalBlobDriver } from './blob/local.js';
import { blobKey } from './blob/driver.js';
import { closeQueues, createRedis, defaultJobOptions, queue, redis } from './queue/index.js';
import { recordDeadLetter, resolveSubjectId } from './queue/dead-letter.js';
import { attachDeadLetterListeners } from './queue/dead-letter.js';
import { ProviderRateLimiter } from './queue/rate-limit.js';
import { ProgressHub, paperChannel, type ProgressSocket } from './ws/progress.js';
import { createTestCorpus, dropTestCorpus } from './testing.js';

afterAll(async () => {
  await closeQueues();
});

describe('retry policy', () => {
  it('uses exponential backoff WITH jitter and capped attempts', () => {
    expect(defaultJobOptions.attempts).toBe(config.queue.attempts);
    expect(defaultJobOptions.attempts).toBeGreaterThan(1);

    const backoff = defaultJobOptions.backoff as {
      type: string;
      delay: number;
      jitter: number;
    };
    expect(backoff.type).toBe('exponential');
    expect(backoff.delay).toBeGreaterThan(0);
    // Without jitter every job failed by one provider outage retries on the
    // same schedule and rebuilds the spike that caused the failure.
    expect(backoff.jitter).toBeGreaterThan(0);
  });

  it('keeps failed jobs so the dead-letter handler can read their bodies back', () => {
    expect(defaultJobOptions.removeOnFail).toBe(false);
  });

  /**
   * bullmq throws "Unknown backoff strategy" at RETRY time if a job asks for
   * a custom strategy the worker never registered -- which would silently
   * disable retries across all six queues. The built-in type cannot fail that
   * way, and this test pins the choice.
   */
  it('does not depend on a custom strategy the worker must remember to register', () => {
    const backoff = defaultJobOptions.backoff as { type: string };
    expect(backoff.type).not.toBe('custom');
  });

  it('declares all six queues from the frozen contract', () => {
    expect(Object.values(QUEUES)).toHaveLength(6);
    for (const name of Object.values(QUEUES)) {
      expect(queue(name).name).toBe(name);
    }
  });
});

describe('dead-lettering', () => {
  it('resolves a subject from each frozen job shape', async () => {
    const corpus = await createTestCorpus();
    try {
      const { rows } = await pool.query<{ paper_id: string }>(
        `INSERT INTO papers (subject_id, exam_year, content_hash)
         VALUES ($1, 2024, $2) RETURNING paper_id`,
        [corpus.subjectId, 'a'.repeat(64)],
      );
      const paperId = String(rows[0]!.paper_id);

      const { rows: qRows } = await pool.query<{ question_id: string }>(
        `INSERT INTO questions (paper_id, q_number, text)
         VALUES ($1, '1', 'Define a deadlock.') RETURNING question_id`,
        [paperId],
      );
      const questionId = String(qRows[0]!.question_id);

      // StatsRecomputeJob / ConceptExtractionJob carry the subject directly.
      expect(await resolveSubjectId({ subjectId: corpus.subjectId })).toBe(corpus.subjectId);
      // ExtractJob and SegmentJob carry only a paper.
      expect(await resolveSubjectId({ paperId, blobUrl: 'x' })).toBe(corpus.subjectId);
      // EmbedJob carries only question ids.
      expect(await resolveSubjectId({ questionIds: [questionId] })).toBe(corpus.subjectId);
      // AdjudicateJob carries one question plus candidates.
      expect(await resolveSubjectId({ questionId, candidateQuestionIds: [] })).toBe(
        corpus.subjectId,
      );
      // Nothing resolvable must be reported, never guessed at.
      expect(await resolveSubjectId({ nothing: true })).toBeNull();
      expect(await resolveSubjectId(null)).toBeNull();
    } finally {
      await dropTestCorpus(corpus);
    }
  });

  it('files an exhausted job as a review_queue row, exactly once', async () => {
    const corpus = await createTestCorpus();
    const { rows } = await pool.query<{ paper_id: string }>(
      `INSERT INTO papers (subject_id, exam_year, content_hash)
       VALUES ($1, 2024, $2) RETURNING paper_id`,
      [corpus.subjectId, 'b'.repeat(64)],
    );
    const paperId = String(rows[0]!.paper_id);

    const log = {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as unknown as Parameters<typeof attachDeadLetterListeners>[0];

    const detach = attachDeadLetterListeners(log);
    let attempts = 0;
    const worker = new Worker(
      QUEUES.ingest,
      async () => {
        attempts += 1;
        throw new Error('extraction exploded');
      },
      { connection: createRedis(), autorun: true },
    );

    try {
      await queue(QUEUES.ingest).add(
        'extract',
        { paperId, blobUrl: 'file:///nope.pdf' },
        {
          jobId: `dlq-test-${paperId}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 50, jitter: 0.5 },
          removeOnFail: false,
        },
      );

      const deadline = Date.now() + 15_000;
      let reviewRows: { review_id: string; kind: string; payload: unknown }[] = [];
      while (Date.now() < deadline) {
        const { rows: found } = await pool.query<{
          review_id: string;
          kind: string;
          payload: unknown;
        }>(
          `SELECT review_id, kind, payload FROM review_queue
            WHERE subject_id = $1 AND kind = 'dlq'`,
          [corpus.subjectId],
        );
        if (found.length > 0) {
          reviewRows = found;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // Retried, then dead-lettered: the job was attempted twice.
      expect(attempts).toBe(2);
      expect(reviewRows).toHaveLength(1);
      expect(reviewRows[0]!.kind).toBe('dlq');

      const payload = reviewRows[0]!.payload as {
        queue: string;
        attemptsMade: number;
        failedReason: string;
        data: { paperId: string };
      };
      expect(payload.queue).toBe(QUEUES.ingest);
      expect(payload.failedReason).toContain('extraction exploded');
      expect(payload.data.paperId).toBe(paperId);

      // A settling window: BullMQ emits `failed` on every attempt, so a
      // handler that did not gate on exhaustion would add a second row here.
      await new Promise((r) => setTimeout(r, 500));
      const { rows: after } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM review_queue WHERE subject_id = $1 AND kind = 'dlq'`,
        [corpus.subjectId],
      );
      expect(after[0]!.n).toBe(1);
    } finally {
      await worker.close();
      await detach();
      await (await queue(QUEUES.ingest).getJob(`dlq-test-${paperId}`))?.remove().catch(() => undefined);
      await dropTestCorpus(corpus);
    }
  });

  it('writes a review row a human can act on', async () => {
    const corpus = await createTestCorpus();
    try {
      const reviewId = await recordDeadLetter(corpus.subjectId, {
        queue: 'embed',
        jobId: 'j1',
        jobName: 'embed',
        attemptsMade: 5,
        failedReason: 'ONNX session failed to start',
        data: { questionIds: ['1', '2'] },
        failedAt: new Date().toISOString(),
      });
      expect(reviewId).toBeTruthy();

      const { rows } = await pool.query<{ status: string; kind: string }>(
        'SELECT status, kind FROM review_queue WHERE review_id = $1',
        [reviewId],
      );
      expect(rows[0]).toMatchObject({ status: 'open', kind: 'dlq' });
    } finally {
      await dropTestCorpus(corpus);
    }
  });
});

describe('rate limiting is per provider, not per queue', () => {
  it('shares one budget across every queue that calls the provider', async () => {
    const client = redis();
    await client.del('ratelimit:provider:gemini');

    const limiter = new ProviderRateLimiter(client, {
      gemini: { capacity: 3, refillPerSecond: 0.001 },
      groq: { capacity: 3, refillPerSecond: 0.001 },
    });

    // Four different queues all call Gemini. A per-queue limiter would let
    // each of them spend the whole budget; the shared bucket does not.
    expect((await limiter.tryTake('gemini')).allowed).toBe(true); // ingest
    expect((await limiter.tryTake('gemini')).allowed).toBe(true); // adjudicate
    expect((await limiter.tryTake('gemini')).allowed).toBe(true); // enrich

    const refused = await limiter.tryTake('gemini'); // generate
    expect(refused.allowed).toBe(false);
    // A refused caller is told when to come back rather than spinning.
    expect(refused.waitMs).toBeGreaterThan(0);

    // Groq has its own bucket: exhausting Gemini must not stop Tutor Chat.
    await client.del('ratelimit:provider:groq');
    expect((await limiter.tryTake('groq')).allowed).toBe(true);

    await client.del('ratelimit:provider:gemini');
    await client.del('ratelimit:provider:groq');
  });

  it('refills over time instead of staying exhausted', async () => {
    const client = redis();
    await client.del('ratelimit:provider:groq');
    const limiter = new ProviderRateLimiter(client, {
      gemini: { capacity: 1, refillPerSecond: 50 },
      groq: { capacity: 1, refillPerSecond: 50 },
    });

    expect((await limiter.tryTake('groq')).allowed).toBe(true);
    expect((await limiter.tryTake('groq')).allowed).toBe(false);
    expect(await limiter.acquire('groq', 1, 2000)).toBe(true);
    await client.del('ratelimit:provider:groq');
  });
});

describe('blob storage', () => {
  it('writes once and reports the second attempt as pre-existing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precedent-blob-'));
    try {
      const driver = new LocalBlobDriver(dir);
      const key = blobKey('42', 'c'.repeat(64));

      const first = await driver.putIfAbsent(key, Buffer.from('original bytes'), 'application/pdf');
      expect(first.created).toBe(true);

      // The same key from a second archive carries different bytes. It must
      // not overwrite the original a citation already points at.
      const second = await driver.putIfAbsent(
        key,
        Buffer.from('different bytes, same paper'),
        'application/pdf',
      );
      expect(second.created).toBe(false);
      expect(second.url).toBe(first.url);

      expect((await driver.get(key))?.toString()).toBe('original bytes');
      expect(await driver.exists(key)).toBe(true);
      expect(await driver.exists(blobKey('42', 'd'.repeat(64)))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a key that would escape the blob root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precedent-blob-'));
    try {
      const driver = new LocalBlobDriver(dir);
      await expect(
        driver.putIfAbsent('../../escaped.pdf', Buffer.from('x'), 'application/pdf'),
      ).rejects.toThrow(/escapes the blob root/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores bytes verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'precedent-blob-'));
    try {
      const driver = new LocalBlobDriver(dir);
      const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]);
      const key = blobKey('1', 'e'.repeat(64));
      const { url } = await driver.putIfAbsent(key, bytes, 'application/pdf');
      expect(url.startsWith('file://')).toBe(true);
      expect(await readFile(join(dir, key))).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('progress hub', () => {
  const fakeSocket = (): ProgressSocket & { sent: string[] } => {
    const sent: string[] = [];
    return {
      sent,
      send: (data: string) => sent.push(data),
      close: () => undefined,
      on: () => undefined,
    };
  };

  const event = (paperId: string): IngestProgressEvent => ({
    paperId,
    stage: 'segmented',
    counts: { questions: 26 },
    message: null,
    at: new Date().toISOString(),
  });

  it('delivers only to the subscribers of that paper', () => {
    const hub = new ProgressHub();
    const a = fakeSocket();
    const b = fakeSocket();

    hub.subscribe(paperChannel('7'), a);
    hub.subscribe(paperChannel('8'), b);

    expect(hub.deliver(event('7'))).toBe(1);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);

    const frame = JSON.parse(a.sent[0]!) as {
      type: string;
      channel: string;
      event: IngestProgressEvent;
    };
    expect(frame.type).toBe('progress');
    expect(frame.channel).toBe('paper:7');
    expect(frame.event.stage).toBe('segmented');
    expect(frame.event.counts).toEqual({ questions: 26 });
  });

  it('fans out to every subscriber of one paper', () => {
    const hub = new ProgressHub();
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    for (const socket of sockets) hub.subscribe(paperChannel('9'), socket);
    expect(hub.deliver(event('9'))).toBe(3);
  });

  it('drops sockets on unsubscribe and on close', () => {
    const hub = new ProgressHub();
    const socket = fakeSocket();

    hub.subscribe(paperChannel('11'), socket);
    hub.unsubscribe(paperChannel('11'), socket);
    expect(hub.subscriberCount(paperChannel('11'))).toBe(0);
    expect(hub.deliver(event('11'))).toBe(0);

    hub.subscribe(paperChannel('12'), socket);
    hub.subscribe(paperChannel('13'), socket);
    hub.remove(socket);
    expect(hub.subscriberCount(paperChannel('12'))).toBe(0);
    expect(hub.subscriberCount(paperChannel('13'))).toBe(0);
  });

  it('evicts a socket that throws rather than delivering to it forever', () => {
    const hub = new ProgressHub();
    const broken: ProgressSocket = {
      send: () => {
        throw new Error('socket is gone');
      },
      close: () => undefined,
      on: () => undefined,
    };
    hub.subscribe(paperChannel('14'), broken);
    expect(hub.deliver(event('14'))).toBe(0);
    expect(hub.subscriberCount(paperChannel('14'))).toBe(0);
  });
});
