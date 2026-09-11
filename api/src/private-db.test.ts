/**
 * The public/private split.
 *
 * The claim under test is not "these queries happen to filter by user" but
 * "an unfiltered private query cannot be written". Three independent things
 * have to hold for that:
 *
 *   1. no statement inside private-db.ts can name a private table without a
 *      user_id predicate -- the module refuses to load if one does;
 *   2. no OTHER file in api/src names a private table at all, so the module
 *      cannot simply be bypassed;
 *   3. access requires a user id at runtime, and one user's rows are never
 *      visible to another.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { closeQueues, queue } from './queue/index.js';
import { QUEUES } from '@precedent/shared';
import { PRIVATE_TABLES, forUser, validateStatements } from './private-db.js';
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

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** private-db.ts owns these tables; test files legitimately assert on them. */
const EXEMPT = new Set(['private-db.ts', 'private-db.test.ts', 'upload.test.ts', 'testing.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') && !EXEMPT.has(entry) ? [full] : [];
  });
}

describe('the private/public split is structural', () => {
  it('routes no private-table SQL outside private-db.ts', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8');
      // Comments discuss these tables by name; only SQL matters here, and
      // SQL in this codebase always names a table after FROM/JOIN/INTO/UPDATE.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      for (const table of PRIVATE_TABLES) {
        const sqlContext = new RegExp(
          String.raw`\b(from|join|into|update)\s+${table}\b`,
          'i',
        );
        if (sqlContext.test(withoutComments)) {
          offenders.push(`${file} -> ${table}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('refuses to load a statement that omits the user filter', () => {
    expect(() =>
      validateStatements({
        leaky: 'SELECT score FROM mastery WHERE concept_id = $1',
      }),
    ).toThrow(/mastery/);

    expect(() =>
      validateStatements({
        leakyJoin: 'SELECT a.score FROM attempts a JOIN clusters c ON c.cluster_id = a.cluster_id',
      }),
    ).toThrow(/attempts/);
  });

  it('accepts a statement that filters, and one that writes user_id', () => {
    expect(() =>
      validateStatements({
        scoped: 'SELECT score FROM mastery WHERE user_id = $1 AND concept_id = $2',
        writes: 'INSERT INTO attempts (user_id, cluster_id, answer_text) VALUES ($1, $2, $3)',
      }),
    ).not.toThrow();
  });

  it('has no way to reach private data without naming a user', () => {
    expect(() => forUser('')).toThrow(/authenticated user/i);
    // There is deliberately no raw-query method on the scope: an escape
    // hatch would make the whole arrangement decorative.
    const scope = forUser('1');
    expect((scope as unknown as Record<string, unknown>)['query']).toBeUndefined();
  });

  it('lists every user_id-bearing table in the schema', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'user_id'
        ORDER BY table_name`,
    );
    /**
     * If a migration adds a private table and nobody updates PRIVATE_TABLES,
     * the enforcement silently stops covering it. This is the tripwire.
     *
     * `users` is excluded and is the one real exception: user_id there is the
     * primary key of the identity table itself, not a foreign key marking
     * somebody's study data. Auth has to read it by id and by email, and it
     * holds no notes, attempts or mastery. Everything else that carries a
     * user_id must be declared.
     */
    const IDENTITY_TABLES = new Set(['users']);
    const inSchema = rows.map((r) => r.table_name).filter((t) => !IDENTITY_TABLES.has(t));
    expect([...PRIVATE_TABLES].sort()).toEqual(inSchema.sort());
  });
});

describe('private data is not visible across users', () => {
  let app: FastifyInstance;
  let corpus: TestCorpus;
  const users: TestUser[] = [];

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

  it('scopes contribution credits to their own user', async () => {
    const alice = await registerUser(app, 'alice');
    const bob = await registerUser(app, 'bob');
    users.push(alice, bob);

    const pdf = makeTextPdf(SAMPLE_EXAM_LINES);
    const send = async (user: TestUser): Promise<string> => {
      const { payload, headers } = multipart(
        { subjectId: corpus.subjectId, examYear: '2024' },
        { buffer: pdf, filename: 'paper.pdf' },
      );
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/upload',
        headers: { ...headers, ...bearer(user) },
        payload,
      });
      return (response.json() as { paperId: string }).paperId;
    };

    const paperId = await send(alice);
    await send(bob); // duplicate: credits bob, not alice

    expect(await forUser(bob.userId).countMyContributions()).toBe(1);
    expect(await forUser(alice.userId).countMyContributions()).toBe(0);
    expect(await forUser(bob.userId).listMyContributedPaperIds()).toEqual([paperId]);
    expect(await forUser(alice.userId).listMyContributedPaperIds()).toEqual([]);

    await (await queue(QUEUES.ingest).getJob(`extract-${paperId}`))?.remove();
  });
});
