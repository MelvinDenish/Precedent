/**
 * Corpus read routes, and the rule that uploaded PDFs are never redistributed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '@precedent/shared';
import type { PaperDetailResponse, Question, SubjectSummary } from '@precedent/shared';
import { pool } from './db.js';
import { closeQueues, queue } from './queue/index.js';
import {
  bearer,
  buildTestServer,
  createTestCorpus,
  dropTestCorpus,
  dropUsers,
  makeTextPdf,
  multipart,
  registerUser,
  SAMPLE_EXAM_LINES,
  type TestCorpus,
  type TestUser,
} from './testing.js';

let app: FastifyInstance;
let corpus: TestCorpus;
let user: TestUser;
let paperId: string;
const users: TestUser[] = [];

beforeAll(async () => {
  app = await buildTestServer();
  await app.ready();
  corpus = await createTestCorpus();
  user = await registerUser(app, 'reader');
  users.push(user);

  const { payload, headers } = multipart(
    { subjectId: corpus.subjectId, examYear: '2024', examSession: 'nov-dec' },
    { buffer: makeTextPdf(SAMPLE_EXAM_LINES), filename: 'paper.pdf' },
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/upload',
    headers: { ...headers, ...bearer(user) },
    payload,
  });
  paperId = (response.json() as { paperId: string }).paperId;

  // The worker is not running in this suite, so segmented questions are
  // inserted directly: the read routes are what is under test, not S2.
  await pool.query(
    `INSERT INTO questions (paper_id, q_number, part_label, part, text, marks, or_group_id)
     VALUES ($1, '9', NULL, 'B', 'Explain paging.', 13, 1),
            ($1, '10', 'a', 'B', 'Describe the banker algorithm.', 13, 2),
            ($1, '1', NULL, 'A', 'Define a deadlock.', 2, NULL)`,
    [paperId],
  );
});

afterAll(async () => {
  await (await queue(QUEUES.ingest).getJob(`extract-${paperId}`))?.remove();
  await dropUsers(users);
  await dropTestCorpus(corpus);
  await app.close();
  await closeQueues();
});

describe('GET /subjects', () => {
  it('returns the contract shape with corpus counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/subjects',
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);

    const subjects = response.json() as SubjectSummary[];
    const mine = subjects.find((s) => s.subjectId === corpus.subjectId);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      code: 'CS23501',
      name: 'Operating Systems',
      paperCount: 1,
      questionCount: 3,
      clusterCount: 0,
      conceptCount: 0,
    });
    // No statistics have been computed, and the response says so rather than
    // implying a regime it cannot support.
    expect(mine!.regime).toBeNull();
    expect(mine!.yearRange).toEqual([2024, 2024]);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/subjects' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /subjects/:subjectId', () => {
  it('returns one subject', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/subjects/${corpus.subjectId}`,
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as SubjectSummary).code).toBe('CS23501');
  });

  it('404s on an unknown subject and 400s on a non-numeric one', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/subjects/99999999',
      headers: bearer(user),
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/subjects/not-a-number',
      headers: bearer(user),
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('GET /papers/:paperId', () => {
  it('returns the paper with its questions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/papers/${paperId}`,
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as PaperDetailResponse;
    expect(body.paper.paperId).toBe(paperId);
    expect(body.paper.examYear).toBe(2024);
    expect(body.questions).toHaveLength(3);
  });

  /**
   * ARCHITECTURE.md section 6: uploaded PDFs are stored but never
   * redistributed by the API. Only extracted question text and citations are
   * served, so the stored locator must not leave the process.
   */
  it('never discloses the blob location', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/papers/${paperId}`,
      headers: bearer(user),
    });
    const body = response.json() as PaperDetailResponse;
    expect(body.paper.blobUrl).toBeNull();

    const { rows } = await pool.query<{ blob_url: string }>(
      'SELECT blob_url FROM papers WHERE paper_id = $1',
      [paperId],
    );
    // The locator exists in the database for the citation trail...
    expect(rows[0]!.blob_url).toContain('papers/');
    // ...and appears nowhere in the response.
    expect(response.body).not.toContain(rows[0]!.blob_url);
    expect(response.body).not.toContain('.blobs');
  });
});

describe('GET /papers/:paperId/questions', () => {
  it('orders questions numerically, not lexically', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/papers/${paperId}/questions`,
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);

    const questions = response.json() as Question[];
    // Sorted as text, '10' would precede '9' and scramble the paper's own
    // ordering; part A comes before part B.
    expect(questions.map((q) => `${q.part}${q.qNumber}${q.partLabel ?? ''}`)).toEqual([
      'A1',
      'B9',
      'B10a',
    ]);
  });

  it('preserves or_group_id, which is only meaningful with the paper', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/papers/${paperId}/questions`,
      headers: bearer(user),
    });
    const questions = response.json() as Question[];
    const byNumber = new Map(questions.map((q) => [q.qNumber, q]));
    expect(byNumber.get('9')!.orGroupId).toBe(1);
    expect(byNumber.get('10')!.orGroupId).toBe(2);
    expect(byNumber.get('1')!.orGroupId).toBeNull();
    for (const question of questions) expect(question.paperId).toBe(paperId);
  });

  it('404s on an unknown paper', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/papers/99999999/questions',
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('health', () => {
  it('answers on both the bare and the prefixed path', async () => {
    for (const url of ['/health', '/api/v1/health']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { ok: boolean }).ok).toBe(true);
    }
  });
});
