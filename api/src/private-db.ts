/**
 * The public/private split, enforced at the query layer.
 *
 * Shared graph tables carry no user_id at all, so a query against them cannot
 * leak one student's data into another's view -- the split is structural, and
 * for those tables there is nothing to enforce.
 *
 * The private tables are the other half, and a convention ("remember to add
 * WHERE user_id = ...") is not enforcement: it fails silently, in the one
 * direction that matters, the first time somebody writes a query in a hurry.
 *
 * So every statement that touches a private table lives in STATEMENTS below,
 * and validateStatements() runs at module load: a statement naming a private
 * table without a user_id predicate throws on import, taking the whole process
 * down before it can serve a request. There is deliberately no raw-SQL method
 * on UserScope -- an escape hatch would make all of this decorative -- and
 * userId is always bound as $1, so an operation cannot be called without one.
 *
 * The companion test asserts that no other file in api/src names a private
 * table, which closes the remaining route: bypassing this module entirely.
 */
import { pool, type Queryable } from './db.js';

/**
 * Tables carrying user_id. Kept in sync with migrations/006_learning.sql plus
 * paper_contributions, which DATA_MODEL.md section 1 names as the single
 * user_id-bearing exception in the shared half: a contribution credit is
 * still one student's record and is not served to another.
 */
export const PRIVATE_TABLES = [
  'user_sources',
  'attempts',
  'mastery',
  'learn_sessions',
  'tutor_sessions',
  'escalations',
  'paper_contributions',
] as const;

export type PrivateTable = (typeof PRIVATE_TABLES)[number];

/**
 * Every statement in the API that reads or writes a private table.
 *
 * $1 is the authenticated user id in all of them, without exception.
 */
const STATEMENTS = {
  creditContribution: `
    INSERT INTO paper_contributions (user_id, paper_id)
    VALUES ($1, $2)
    ON CONFLICT (paper_id, user_id) DO NOTHING
  `,
  countMyContributions: `
    SELECT count(*)::int AS n
      FROM paper_contributions
     WHERE user_id = $1
  `,
  listMyContributedPaperIds: `
    SELECT paper_id
      FROM paper_contributions
     WHERE user_id = $1
     ORDER BY at DESC
     LIMIT $2
  `,
} as const satisfies Record<string, string>;

export type StatementName = keyof typeof STATEMENTS;

function mentionsPrivateTable(sql: string): PrivateTable[] {
  const lowered = sql.toLowerCase();
  return PRIVATE_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(lowered));
}

/**
 * A statement is user-scoped when it filters on user_id, or when it supplies
 * user_id as a written column -- an INSERT naming user_id cannot create a row
 * belonging to anyone but the caller, since $1 is the only value bound to it.
 */
function isUserScoped(sql: string): boolean {
  const lowered = sql.toLowerCase().replace(/\s+/g, ' ');
  const filtered = /\buser_id\s*=\s*\$1\b/.test(lowered);
  const inserted = /\binsert\s+into\s+\w+\s*\([^)]*\buser_id\b[^)]*\)/.test(lowered);
  return filtered || inserted;
}

/** Runs at import. A violation is a boot failure, never a runtime surprise. */
export function validateStatements(
  statements: Record<string, string> = STATEMENTS,
): void {
  for (const [name, sql] of Object.entries(statements)) {
    const tables = mentionsPrivateTable(sql);
    if (tables.length > 0 && !isUserScoped(sql)) {
      throw new Error(
        `private-db: statement "${name}" touches private table(s) ` +
          `${tables.join(', ')} without a user_id = $1 predicate. ` +
          'Every private query is scoped to the authenticated user.',
      );
    }
  }
}

validateStatements();

/**
 * Private data access, bound to one authenticated user for its whole lifetime.
 *
 * Obtained only from forUser(), which rejects a missing id, so there is no
 * way to reach a private table without having named a user first.
 */
export class UserScope {
  constructor(
    readonly userId: string,
    private readonly db: Queryable,
  ) {}

  /**
   * Records a contribution credit. ON CONFLICT DO NOTHING because the credit
   * is idempotent per (paper, user): a student who uploads the same paper
   * twice is one contributor, and the second upload must not 500 on the
   * primary key.
   */
  async creditContribution(paperId: string): Promise<void> {
    await this.db.query(STATEMENTS.creditContribution, [this.userId, paperId]);
  }

  async countMyContributions(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(STATEMENTS.countMyContributions, [
      this.userId,
    ]);
    return rows[0]?.n ?? 0;
  }

  async listMyContributedPaperIds(limit = 100): Promise<string[]> {
    const { rows } = await this.db.query<{ paper_id: string }>(
      STATEMENTS.listMyContributedPaperIds,
      [this.userId, limit],
    );
    return rows.map((r) => String(r.paper_id));
  }
}

/** The only way to obtain private data access. */
export function forUser(userId: string, db: Queryable = pool): UserScope {
  if (!userId) {
    throw new Error('private-db: forUser requires an authenticated user id.');
  }
  return new UserScope(userId, db);
}
