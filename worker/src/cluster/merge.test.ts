import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OrRuleViolationError,
  VersionConflictError,
  mergeClusters,
  withVersionRetry,
} from './merge.js';

/**
 * Integration tests against a real Postgres, because the behaviour under
 * test IS the database's: row locks, transaction isolation and version
 * guards cannot be demonstrated against a mock.
 *
 * Needs `docker compose up -d postgres` and `npm run migrate`.
 */
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://precedent:precedent@localhost:5432/precedent',
  max: 6,
});

afterAll(async () => {
  await pool.end();
});

interface Fixture {
  subjectId: string;
  paperA: string;
  paperB: string;
  clusterOne: string;
  clusterTwo: string;
}

/** A minimal synthetic corpus: two papers and two clusters. */
async function seed(): Promise<Fixture> {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const uni = await pool.query<{ university_id: string }>(
    `INSERT INTO universities (name, slug) VALUES ('Test U', $1) RETURNING university_id`,
    [`test-${unique}`],
  );
  const universityId = uni.rows[0]!.university_id;

  const reg = await pool.query<{ regulation_id: string }>(
    `INSERT INTO regulations (university_id, code) VALUES ($1, 'R2023') RETURNING regulation_id`,
    [universityId],
  );
  const subject = await pool.query<{ subject_id: string }>(
    `INSERT INTO subjects (university_id, regulation_id, code, name)
     VALUES ($1, $2, 'CS00001', 'Test Subject') RETURNING subject_id`,
    [universityId, reg.rows[0]!.regulation_id],
  );
  const subjectId = subject.rows[0]!.subject_id;

  const mkPaper = async (year: number, prefix: string): Promise<string> => {
    const { rows } = await pool.query<{ paper_id: string }>(
      `INSERT INTO papers (subject_id, exam_year, content_hash) VALUES ($1, $2, $3)
       RETURNING paper_id`,
      [subjectId, year, `${prefix}${unique}`.padEnd(64, '0').slice(0, 64)],
    );
    return rows[0]!.paper_id;
  };

  const mkCluster = async (label: string): Promise<string> => {
    const { rows } = await pool.query<{ cluster_id: string }>(
      `INSERT INTO clusters (subject_id, canonical_text, canonical_text_hash, marks_band)
       VALUES ($1, $2, $3, 13) RETURNING cluster_id`,
      [subjectId, `canonical ${label}`, `${label}${unique}`.padEnd(64, 'x').slice(0, 64)],
    );
    return rows[0]!.cluster_id;
  };

  return {
    subjectId,
    paperA: await mkPaper(2023, 'a'),
    paperB: await mkPaper(2024, 'b'),
    clusterOne: await mkCluster('one'),
    clusterTwo: await mkCluster('two'),
  };
}

async function addQuestion(
  paperId: string,
  clusterId: string,
  qNumber: string,
  partLabel: string | null,
  orGroupId: number | null,
): Promise<string> {
  const { rows } = await pool.query<{ question_id: string }>(
    `INSERT INTO questions (paper_id, q_number, part_label, text, marks, or_group_id)
     VALUES ($1, $2, $3, $4, 13, $5) RETURNING question_id`,
    [paperId, qNumber, partLabel, `Question ${qNumber}${partLabel ?? ''}`, orGroupId],
  );
  const questionId = rows[0]!.question_id;
  await pool.query(
    `INSERT INTO question_cluster (question_id, cluster_id, decided_by, confidence)
     VALUES ($1, $2, 'rule', 1.0)`,
    [questionId, clusterId],
  );
  return questionId;
}

async function versionOf(clusterId: string): Promise<number> {
  const { rows } = await pool.query<{ version: number }>(
    'SELECT version FROM clusters WHERE cluster_id = $1',
    [clusterId],
  );
  return rows[0]?.version ?? -1;
}

let fx: Fixture;
beforeEach(async () => {
  fx = await seed();
});

describe('merging clusters', () => {
  it('moves every member and removes the absorbed cluster', async () => {
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperB, fx.clusterTwo, '13', 'b', 13);

    const result = await withVersionRetry(pool, (tx) =>
      mergeClusters(tx, {
        survivingClusterId: fx.clusterOne,
        absorbedClusterId: fx.clusterTwo,
        expectedVersions: {},
        decidedBy: 'agent',
        confidence: 0.92,
      }),
    );

    expect(result.movedQuestions).toBe(1);

    const members = await pool.query('SELECT 1 FROM question_cluster WHERE cluster_id = $1', [
      fx.clusterOne,
    ]);
    expect(members.rowCount).toBe(2);

    const gone = await pool.query('SELECT 1 FROM clusters WHERE cluster_id = $1', [fx.clusterTwo]);
    expect(gone.rowCount).toBe(0);
  });

  it('bumps the surviving cluster version', async () => {
    const before = await versionOf(fx.clusterOne);
    await withVersionRetry(pool, (tx) =>
      mergeClusters(tx, {
        survivingClusterId: fx.clusterOne,
        absorbedClusterId: fx.clusterTwo,
        expectedVersions: {},
        decidedBy: 'agent',
        confidence: 0.9,
      }),
    );
    expect(await versionOf(fx.clusterOne)).toBe(before + 1);
  });
});

describe('the OR rule at the merge boundary', () => {
  /**
   * The UNDER-STRICT failure. 11(a) and 11(b) in one paper are alternatives
   * a student chooses between, so they are different questions however
   * similar their wording, and merging them inflates every count.
   *
   * Candidate retrieval excludes same-paper questions, so this pair can only
   * reach a merge transitively through two clusters -- which is what is
   * simulated here, and why the guard has to live at the merge boundary too.
   */
  it('refuses to merge two clusters holding same-paper OR alternatives', async () => {
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperA, fx.clusterTwo, '11', 'b', 11);

    await expect(
      withVersionRetry(pool, (tx) =>
        mergeClusters(tx, {
          survivingClusterId: fx.clusterOne,
          absorbedClusterId: fx.clusterTwo,
          expectedVersions: {},
          decidedBy: 'agent',
          confidence: 0.99, // high confidence must NOT override the rule
        }),
      ),
    ).rejects.toThrow(OrRuleViolationError);

    // And nothing moved.
    const still = await pool.query('SELECT 1 FROM clusters WHERE cluster_id = $1', [fx.clusterTwo]);
    expect(still.rowCount).toBe(1);
  });

  /**
   * The OVER-STRICT failure, which is the dangerous one because it is
   * silent. 2023 Q11(a) and 2024 Q13(b) are the same question sitting in
   * different OR slots in different years -- precisely the cross-year
   * recurrence this product exists to find. A rule checking or_group_id
   * without paper_id would suppress it and deflate every count, raising no
   * error anywhere.
   */
  it('ALLOWS a cross-year OR-slot pair to merge', async () => {
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperB, fx.clusterTwo, '13', 'b', 13);

    const result = await withVersionRetry(pool, (tx) =>
      mergeClusters(tx, {
        survivingClusterId: fx.clusterOne,
        absorbedClusterId: fx.clusterTwo,
        expectedVersions: {},
        decidedBy: 'agent',
        confidence: 0.88,
      }),
    );
    expect(result.movedQuestions).toBe(1);
  });

  it('ALLOWS a merge when the or_group id coincides across two papers', async () => {
    // The specific trap: same or_group_id, different paper. or_group_id is
    // scoped per-paper, so an id-only check would wrongly block this.
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperB, fx.clusterTwo, '11', 'b', 11);

    const result = await withVersionRetry(pool, (tx) =>
      mergeClusters(tx, {
        survivingClusterId: fx.clusterOne,
        absorbedClusterId: fx.clusterTwo,
        expectedVersions: {},
        decidedBy: 'agent',
        confidence: 0.9,
      }),
    );
    expect(result.movedQuestions).toBe(1);
  });
});

describe('optimistic concurrency', () => {
  it('rejects a merge staged against a stale version', async () => {
    const stale = await versionOf(fx.clusterOne);
    // Someone else mutates the cluster first.
    await pool.query('UPDATE clusters SET version = version + 1 WHERE cluster_id = $1', [
      fx.clusterOne,
    ]);

    const run = async (): Promise<unknown> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await mergeClusters(client, {
          survivingClusterId: fx.clusterOne,
          absorbedClusterId: fx.clusterTwo,
          expectedVersions: { [fx.clusterOne]: stale },
          decidedBy: 'agent',
          confidence: 0.9,
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    await expect(run()).rejects.toThrow(VersionConflictError);
  });

  /**
   * The real race. Two workers merge the same pair concurrently. Exactly one
   * must win, and the loser must FAIL rather than silently overwrite,
   * because a lost merge decision leaves the statistics wrong with nothing
   * logged to say so.
   */
  it('lets exactly one of two concurrent merges win, and orphans nothing', async () => {
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperB, fx.clusterTwo, '13', 'b', 13);

    const attempt = (surviving: string, absorbed: string) =>
      withVersionRetry(
        pool,
        (tx) =>
          mergeClusters(tx, {
            survivingClusterId: surviving,
            absorbedClusterId: absorbed,
            expectedVersions: {},
            decidedBy: 'agent',
            confidence: 0.9,
          }),
        { maxAttempts: 1 },
      );

    const results = await Promise.allSettled([
      attempt(fx.clusterOne, fx.clusterTwo),
      attempt(fx.clusterTwo, fx.clusterOne),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const orphans = await pool.query(
      `SELECT 1 FROM question_cluster qc
        WHERE NOT EXISTS (SELECT 1 FROM clusters c WHERE c.cluster_id = qc.cluster_id)`,
    );
    expect(orphans.rowCount).toBe(0);
  });

  /**
   * Deadlock is prevented structurally, by locking both rows in one
   * transaction ordered by cluster_id. Without that ordering, opposing
   * merges each hold the row the other wants and Postgres has to break the
   * cycle. This asserts the pair resolves rather than deadlocking.
   */
  it('does not deadlock when two workers merge the same pair in opposite directions', async () => {
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperB, fx.clusterTwo, '13', 'b', 13);

    const settled = await Promise.allSettled([
      withVersionRetry(pool, (tx) =>
        mergeClusters(tx, {
          survivingClusterId: fx.clusterOne,
          absorbedClusterId: fx.clusterTwo,
          expectedVersions: {},
          decidedBy: 'agent',
          confidence: 0.9,
        }),
      ),
      withVersionRetry(pool, (tx) =>
        mergeClusters(tx, {
          survivingClusterId: fx.clusterTwo,
          absorbedClusterId: fx.clusterOne,
          expectedVersions: {},
          decidedBy: 'agent',
          confidence: 0.9,
        }),
      ),
    ]);

    expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        expect(String(outcome.reason)).not.toMatch(/deadlock/i);
      }
    }
  });

  it('does not retry an OR-rule refusal, which would refuse identically', async () => {
    await addQuestion(fx.paperA, fx.clusterOne, '11', 'a', 11);
    await addQuestion(fx.paperA, fx.clusterTwo, '11', 'b', 11);

    const started = Date.now();
    await expect(
      withVersionRetry(
        pool,
        (tx) =>
          mergeClusters(tx, {
            survivingClusterId: fx.clusterOne,
            absorbedClusterId: fx.clusterTwo,
            expectedVersions: {},
            decidedBy: 'agent',
            confidence: 0.95,
          }),
        { maxAttempts: 4, baseDelayMs: 200 },
      ),
    ).rejects.toThrow(OrRuleViolationError);

    // Returned immediately rather than backing off four times.
    expect(Date.now() - started).toBeLessThan(600);
  });
});

describe('content-addressed caches survive a merge', () => {
  /**
   * Neither cache is keyed on cluster_id, so a merge cannot orphan an entry
   * or leave a stale one reachable under a reused id. This asserts the
   * property rather than trusting the comment that claims it.
   */
  it('leaves a cached answer reachable after its cluster is absorbed', async () => {
    const hash = `cache${Date.now()}`.padEnd(64, '0').slice(0, 64);
    await pool.query(
      `INSERT INTO answer_cache (canonical_text_hash, marks_band, body, sources)
       VALUES ($1, 13, 'A cached canonical answer.', '[]'::jsonb)`,
      [hash],
    );
    await pool.query('UPDATE clusters SET canonical_text_hash = $1 WHERE cluster_id = $2', [
      hash,
      fx.clusterTwo,
    ]);

    await withVersionRetry(pool, (tx) =>
      mergeClusters(tx, {
        survivingClusterId: fx.clusterOne,
        absorbedClusterId: fx.clusterTwo,
        expectedVersions: {},
        decidedBy: 'agent',
        confidence: 0.9,
      }),
    );

    const cached = await pool.query(
      'SELECT body FROM answer_cache WHERE canonical_text_hash = $1',
      [hash],
    );
    expect(cached.rowCount).toBe(1);
  });
});
