/**
 * Cluster merge, under optimistic concurrency.
 *
 * Clusters are mutable by design and multiple workers touch them at once, so
 * every mutation is guarded by the version it was read at. A merge touches
 * TWO clusters, which is where the interesting failures live.
 *
 * TWO HAZARDS, BOTH HANDLED STRUCTURALLY RATHER THAN BY HOPING:
 *
 *   1. Deadlock. Two workers merging the same pair in opposite directions
 *      would each hold the row the other wants. Both rows are locked inside
 *      one transaction with SELECT ... FOR UPDATE ORDERED BY cluster_id
 *      ASCENDING, which makes the cycle impossible to form rather than
 *      merely unlikely.
 *
 *   2. Lost updates. A version mismatch means another worker won the race,
 *      so the caller re-reads and retries, bounded, then dead-letters. It
 *      never overwrites, because the losing write would silently discard a
 *      merge decision and leave the statistics wrong with no error raised.
 *
 * The OR rule is enforced HERE, in code, before any write -- never in a
 * prompt. Candidate retrieval already excludes same-paper questions, but
 * merging two existing CLUSTERS can still pull an OR sibling in
 * transitively, and that is the path that silently inflates every count.
 *
 * See docs/ARCHITECTURE.md sections 2.3 and 2.4.
 */

import { findBlockingOrPair } from '@precedent/shared';
import type pg from 'pg';

export class VersionConflictError extends Error {
  constructor(readonly clusterId: string) {
    super(`Cluster ${clusterId} changed under us; re-read and retry.`);
    this.name = 'VersionConflictError';
  }
}

export class OrRuleViolationError extends Error {
  constructor(
    readonly leftQuestionId: string,
    readonly rightQuestionId: string,
  ) {
    super(
      `Refusing to merge: questions ${leftQuestionId} and ${rightQuestionId} are ` +
        'OR-alternatives in the same paper, so they are different questions.',
    );
    this.name = 'OrRuleViolationError';
  }
}

interface ClusterRow {
  cluster_id: string;
  version: number;
}

interface MemberRow {
  question_id: string;
  paper_id: string;
  or_group_id: number | null;
}

async function loadMembers(tx: pg.PoolClient, clusterId: string): Promise<MemberRow[]> {
  const { rows } = await tx.query<MemberRow>(
    `SELECT q.question_id::text, q.paper_id::text, q.or_group_id
       FROM question_cluster qc
       JOIN questions q USING (question_id)
      WHERE qc.cluster_id = $1`,
    [clusterId],
  );
  return rows;
}

export interface MergeResult {
  survivingClusterId: string;
  absorbedClusterId: string;
  movedQuestions: number;
  newVersion: number;
}

/**
 * Merges `absorbed` into `surviving`, guarded by the versions both were read
 * at. A mismatch throws rather than overwriting, and the job retries from a
 * fresh read.
 */
export async function mergeClusters(
  tx: pg.PoolClient,
  params: {
    survivingClusterId: string;
    absorbedClusterId: string;
    expectedVersions: Record<string, number>;
    decidedBy: 'agent' | 'human' | 'rule';
    confidence: number;
  },
): Promise<MergeResult> {
  const { survivingClusterId, absorbedClusterId, expectedVersions } = params;

  if (survivingClusterId === absorbedClusterId) {
    throw new Error('A cluster cannot be merged into itself.');
  }

  // Lock both rows in one transaction, ordered by id, so two workers merging
  // the same pair in opposite directions queue rather than deadlock.
  const ordered = [survivingClusterId, absorbedClusterId].sort();
  const { rows: locked } = await tx.query<ClusterRow>(
    `SELECT cluster_id::text, version
       FROM clusters
      WHERE cluster_id = ANY($1::bigint[])
      ORDER BY cluster_id ASC
        FOR UPDATE`,
    [ordered],
  );

  if (locked.length !== 2) {
    throw new Error('One of the clusters no longer exists; it was merged or split already.');
  }

  for (const row of locked) {
    const expected = expectedVersions[row.cluster_id];
    if (expected !== undefined && expected !== row.version) {
      throw new VersionConflictError(row.cluster_id);
    }
  }

  // THE OR RULE, in code, before the write.
  const [leftMembers, rightMembers] = await Promise.all([
    loadMembers(tx, survivingClusterId),
    loadMembers(tx, absorbedClusterId),
  ]);

  const blocking = findBlockingOrPair(
    leftMembers.map((m) => ({ paperId: m.paper_id, orGroupId: m.or_group_id, id: m.question_id })),
    rightMembers.map((m) => ({ paperId: m.paper_id, orGroupId: m.or_group_id, id: m.question_id })),
  );
  if (blocking) {
    throw new OrRuleViolationError(blocking.left.id, blocking.right.id);
  }

  const moved = await tx.query(
    `UPDATE question_cluster
        SET cluster_id = $1, decided_by = $3, confidence = $4, decided_at = now()
      WHERE cluster_id = $2`,
    [survivingClusterId, absorbedClusterId, params.decidedBy, params.confidence],
  );

  // Version-guarded bump. Zero rows means another worker won after the lock
  // was taken -- which should be impossible here, but is checked anyway,
  // because an unguarded write is how lost updates enter a system.
  const expectedSurviving = expectedVersions[survivingClusterId];
  const bump = await tx.query<{ version: number }>(
    expectedSurviving === undefined
      ? 'UPDATE clusters SET version = version + 1 WHERE cluster_id = $1 RETURNING version'
      : `UPDATE clusters SET version = version + 1
          WHERE cluster_id = $1 AND version = $2 RETURNING version`,
    expectedSurviving === undefined
      ? [survivingClusterId]
      : [survivingClusterId, expectedSurviving],
  );
  if (bump.rowCount === 0) throw new VersionConflictError(survivingClusterId);

  // The absorbed row goes only after its members have moved, so a crash
  // mid-transaction cannot orphan questions.
  await tx.query('DELETE FROM clusters WHERE cluster_id = $1', [absorbedClusterId]);

  /**
   * NOTHING INVALIDATES answer_cache OR lesson_cache HERE, AND THAT IS THE
   * POINT. Both are keyed on a content hash rather than a cluster id, so a
   * merge cannot orphan an entry or leave a stale one reachable under a
   * reused id. Explicit invalidation inside every merge and split would be
   * more code and more bugs for no benefit.
   * See docs/DATA_MODEL.md section 6.
   */

  return {
    survivingClusterId,
    absorbedClusterId,
    movedQuestions: moved.rowCount ?? 0,
    newVersion: bump.rows[0]!.version,
  };
}

/**
 * Runs a cluster mutation, retrying on version conflicts with jittered
 * backoff, then giving up so the caller can dead-letter it.
 *
 * Bounded on purpose: an unbounded retry against a genuinely contended
 * cluster is a livelock, and a job that never completes is harder to notice
 * than one that fails.
 */
export async function withVersionRetry<T>(
  pool: pg.Pool,
  operation: (tx: pg.PoolClient) => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 20;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      lastError = err;
      // Only a version conflict is worth retrying. An OR-rule violation is a
      // correct refusal, and it will refuse identically next time.
      if (!(err instanceof VersionConflictError)) throw err;

      // Jitter, so two workers that collided do not collide again in step.
      const delay = baseDelayMs * 2 ** attempt * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      client.release();
    }
  }
  throw lastError;
}
