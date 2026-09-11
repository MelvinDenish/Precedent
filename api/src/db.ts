/**
 * Postgres pool.
 *
 * One database, no separate vector store: hybrid queries -- relational
 * predicates AND vector similarity in one statement -- are impossible across
 * two systems, and candidate retrieval needs exactly that.
 */
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Neon and RDS both suspend or drop idle connections.
  keepAlive: true,
});

export type Queryable = pg.Pool | pg.PoolClient;

/** Runs fn inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
