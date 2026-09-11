/**
 * Upload rate limiting is PER USER, not per IP.
 *
 * The distinction is not cosmetic: an affiliated college sits behind one
 * campus NAT, so an IP-keyed limit throttles every student there as though
 * they were one person. Nothing in the idempotency suite can tell the two
 * apart -- it makes five uploads from five users, which is under the limit
 * either way -- so the check has to drive one user over the limit and then
 * show that a different user is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '@precedent/shared';
import { config } from './config.js';
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
const users: TestUser[] = [];
const paperIds = new Set<string>();

/** All requests come from the same address, as they would behind one NAT. */
const SHARED_IP = '203.0.113.7';

const pdf = makeTextPdf(SAMPLE_EXAM_LINES);

async function upload(user: TestUser): Promise<number> {
  const { payload, headers } = multipart(
    { subjectId: corpus.subjectId, examYear: '2024' },
    { buffer: pdf, filename: 'paper.pdf' },
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/upload',
    headers: { ...headers, ...bearer(user), 'x-forwarded-for': SHARED_IP },
    remoteAddress: SHARED_IP,
    payload,
  });
  if (response.statusCode < 300) {
    paperIds.add((response.json() as { paperId: string }).paperId);
  }
  return response.statusCode;
}

beforeAll(async () => {
  app = await buildTestServer();
  await app.ready();
  corpus = await createTestCorpus();
});

afterAll(async () => {
  for (const paperId of paperIds) {
    await (await queue(QUEUES.ingest).getJob(`extract-${paperId}`))?.remove();
  }
  await dropUsers(users);
  await dropTestCorpus(corpus);
  await app.close();
  await closeQueues();
});

describe('upload rate limiting', () => {
  it('limits one user without limiting another on the same address', async () => {
    const heavy = await registerUser(app, 'heavy');
    const bystander = await registerUser(app, 'bystander');
    users.push(heavy, bystander);

    // Drive the first user past the allowance. After the first upload these
    // are all duplicates, so each is a fast path.
    let sawTooManyRequests = false;
    for (let i = 0; i < config.upload.ratePerWindow + 3; i += 1) {
      if ((await upload(heavy)) === 429) {
        sawTooManyRequests = true;
        break;
      }
    }
    expect(sawTooManyRequests).toBe(true);

    // The second student shares the address and has uploaded nothing. If the
    // limiter were keyed on IP, this would be 429 too.
    const bystanderStatus = await upload(bystander);
    expect(bystanderStatus).not.toBe(429);
    expect([200, 202]).toContain(bystanderStatus);
  });
});
