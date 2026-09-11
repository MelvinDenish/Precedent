/**
 * The idempotency guarantee, end to end against a real Postgres.
 *
 * The verification target from the brief: five uploads of the same paper
 * under different filenames produce exactly one papers row, four contributor
 * credits and zero reprocessing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UploadResponse } from '@precedent/shared';
import { pool } from './db.js';
import { closeQueues, queue } from './queue/index.js';
import { QUEUES } from '@precedent/shared';
import {
  bearer,
  buildTestServer,
  createTestCorpus,
  dropTestCorpus,
  dropUsers,
  makeScanPdf,
  makeTextPdf,
  multipart,
  registerUser,
  SAMPLE_EXAM_LINES,
  type TestCorpus,
  type TestUser,
} from './testing.js';

let app: FastifyInstance;
let corpus: TestCorpus;
const users: TestUser[] = [];

async function upload(
  user: TestUser,
  subjectId: string,
  file: Buffer,
  filename: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: UploadResponse }> {
  const { payload, headers } = multipart(
    { subjectId, examYear: '2024', examSession: 'nov-dec', examType: 'endsem', ...extra },
    { buffer: file, filename },
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/upload',
    headers: { ...headers, ...bearer(user) },
    payload,
  });
  return { status: response.statusCode, body: response.json() as UploadResponse };
}

const countPapers = async (subjectId: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM papers WHERE subject_id = $1',
    [subjectId],
  );
  return rows[0]!.n;
};

const countContributions = async (paperId: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM paper_contributions WHERE paper_id = $1',
    [paperId],
  );
  return rows[0]!.n;
};

beforeAll(async () => {
  app = await buildTestServer();
  await app.ready();
  corpus = await createTestCorpus();
});

afterAll(async () => {
  await dropUsers(users);
  await dropTestCorpus(corpus);
  await app.close();
  await closeQueues();
});

describe('POST /upload idempotency', () => {
  it('five uploads of one paper produce one paper, four credits and one job', async () => {
    const pdf = makeTextPdf(SAMPLE_EXAM_LINES);

    const uploaders: TestUser[] = [];
    for (let i = 0; i < 5; i += 1) {
      const user = await registerUser(app, `contributor${i}`);
      uploaders.push(user);
      users.push(user);
    }

    const results: { status: number; body: UploadResponse }[] = [];
    for (const [index, user] of uploaders.entries()) {
      // Different filename each time: the filename must have no bearing on
      // identity, only the normalized content does.
      results.push(await upload(user, corpus.subjectId, pdf, `os-paper-copy-${index}.pdf`));
    }

    const created = results.filter((r) => r.body.created);
    const duplicates = results.filter((r) => !r.body.created);

    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(4);

    expect(created[0]!.status).toBe(202);
    expect(created[0]!.body.jobId).not.toBeNull();

    // Nothing is reprocessed: a duplicate gets no job at all.
    for (const duplicate of duplicates) {
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.jobId).toBeNull();
    }

    // All five resolve to the same paper.
    const paperIds = new Set(results.map((r) => r.body.paperId));
    expect(paperIds.size).toBe(1);

    const paperId = created[0]!.body.paperId;
    expect(await countPapers(corpus.subjectId)).toBe(1);
    expect(await countContributions(paperId)).toBe(4);

    // Exactly one ingest job exists for this paper, and the deterministic
    // job id is what guarantees that.
    const job = await queue(QUEUES.ingest).getJob(`extract-${paperId}`);
    expect(job).toBeTruthy();
    await job?.remove();

    // The paper never left the queued state, so no stage was re-run.
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM papers WHERE paper_id = $1',
      [paperId],
    );
    expect(rows[0]!.status).toBe('queued');
  });

  it('dedupes the same paper from two archives despite different bytes', async () => {
    const user = await registerUser(app, 'cross-archive');
    users.push(user);

    // Same paper, two archives: a different PDF producer, different internal
    // whitespace, and a registration number the second archive stamped on.
    const archiveOne = makeTextPdf(SAMPLE_EXAM_LINES, 'ArchiveOne-Producer');
    const archiveTwo = makeTextPdf(
      [
        SAMPLE_EXAM_LINES[0]!.replace(/ /g, '   '),
        'Reg. No.: 2021CS0142',
        ...SAMPLE_EXAM_LINES.slice(1),
      ],
      'ArchiveTwo-Totally-Different-Producer',
    );

    expect(archiveOne.equals(archiveTwo)).toBe(false);

    const first = await upload(user, corpus.otherSubjectId, archiveOne, 'from-archive-one.pdf');
    const second = await upload(user, corpus.otherSubjectId, archiveTwo, 'from-archive-two.pdf');

    expect(first.body.created).toBe(true);
    expect(second.body.created).toBe(false);
    expect(second.body.paperId).toBe(first.body.paperId);
    expect(await countPapers(corpus.otherSubjectId)).toBe(1);

    await (await queue(QUEUES.ingest).getJob(`extract-${first.body.paperId}`))?.remove();
  });

  /**
   * The regression test for the failure that would have been catastrophic and
   * silent: most of this corpus is image-only scans, and hashing their empty
   * text layer would have collapsed every one of them into a single row.
   */
  it('does NOT collide two different scanned papers with no text layer', async () => {
    const user = await registerUser(app, 'scans');
    users.push(user);

    const local = await createTestCorpus();
    try {
      const scanA = makeScanPdf(1);
      const scanB = makeScanPdf(2);

      const a = await upload(user, local.subjectId, scanA, 'scan-a.pdf');
      const b = await upload(user, local.subjectId, scanB, 'scan-b.pdf');

      expect(a.body.created).toBe(true);
      expect(b.body.created).toBe(true);
      expect(a.body.paperId).not.toBe(b.body.paperId);
      expect(await countPapers(local.subjectId)).toBe(2);

      // Both are marked for vision, which is also the signal to the worker
      // that their content hash is provisional and must be recomputed.
      const { rows } = await pool.query<{ text_source: string }>(
        'SELECT text_source FROM papers WHERE subject_id = $1',
        [local.subjectId],
      );
      expect(rows.map((r) => r.text_source)).toEqual(['vision', 'vision']);

      for (const result of [a, b]) {
        await (await queue(QUEUES.ingest).getJob(`extract-${result.body.paperId}`))?.remove();
      }
    } finally {
      await dropTestCorpus(local);
    }
  });

  it('re-uploading a scan byte-identically still dedupes', async () => {
    const user = await registerUser(app, 'scan-dupe');
    users.push(user);
    const other = await registerUser(app, 'scan-dupe-2');
    users.push(other);

    const local = await createTestCorpus();
    try {
      const scan = makeScanPdf(7);
      const first = await upload(user, local.subjectId, scan, 'a.pdf');
      const second = await upload(other, local.subjectId, scan, 'b.pdf');

      expect(first.body.created).toBe(true);
      expect(second.body.created).toBe(false);
      expect(await countPapers(local.subjectId)).toBe(1);
      expect(await countContributions(first.body.paperId)).toBe(1);

      await (await queue(QUEUES.ingest).getJob(`extract-${first.body.paperId}`))?.remove();
    } finally {
      await dropTestCorpus(local);
    }
  });

  it('scopes the hash per subject: one paper under two subjects is two rows', async () => {
    const user = await registerUser(app, 'two-subjects');
    users.push(user);

    const local = await createTestCorpus();
    try {
      const pdf = makeTextPdf(SAMPLE_EXAM_LINES);
      const a = await upload(user, local.subjectId, pdf, 'p.pdf');
      const b = await upload(user, local.otherSubjectId, pdf, 'p.pdf');

      expect(a.body.created).toBe(true);
      expect(b.body.created).toBe(true);
      expect(a.body.paperId).not.toBe(b.body.paperId);

      for (const result of [a, b]) {
        await (await queue(QUEUES.ingest).getJob(`extract-${result.body.paperId}`))?.remove();
      }
    } finally {
      await dropTestCorpus(local);
    }
  });

  it('records one credit per contributor even when one student uploads twice', async () => {
    const owner = await registerUser(app, 'owner');
    const repeat = await registerUser(app, 'repeat');
    users.push(owner, repeat);

    const local = await createTestCorpus();
    try {
      const pdf = makeTextPdf(SAMPLE_EXAM_LINES);
      const first = await upload(owner, local.subjectId, pdf, 'one.pdf');
      // The (paper_id, user_id) primary key would reject the second of these
      // without ON CONFLICT DO NOTHING.
      await upload(repeat, local.subjectId, pdf, 'two.pdf');
      const third = await upload(repeat, local.subjectId, pdf, 'three.pdf');

      expect(third.status).toBe(200);
      expect(await countContributions(first.body.paperId)).toBe(1);

      await (await queue(QUEUES.ingest).getJob(`extract-${first.body.paperId}`))?.remove();
    } finally {
      await dropTestCorpus(local);
    }
  });
});

describe('POST /upload validation', () => {
  it('rejects an unauthenticated upload', async () => {
    const { payload, headers } = multipart(
      { subjectId: corpus.subjectId, examYear: '2024' },
      { buffer: makeTextPdf(SAMPLE_EXAM_LINES), filename: 'x.pdf' },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/upload',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a file that is not a PDF', async () => {
    const user = await registerUser(app, 'not-pdf');
    users.push(user);
    const result = await upload(
      user,
      corpus.subjectId,
      Buffer.from('this is plainly not a pdf'),
      'notes.txt',
    );
    expect(result.status).toBe(415);
  });

  it('rejects an unknown subject', async () => {
    const user = await registerUser(app, 'bad-subject');
    users.push(user);
    const result = await upload(
      user,
      '999999999',
      makeTextPdf(SAMPLE_EXAM_LINES),
      'x.pdf',
    );
    expect(result.status).toBe(404);
  });
});
