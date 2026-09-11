/**
 * Migration runner.
 *
 * Numbered NNN_name.sql files applied in order, each inside a transaction,
 * tracked in schema_migrations(version, applied_at, checksum).
 *
 * There is deliberately NO boot-time DDL anywhere in this codebase. The
 * predecessor project ran 400 lines of CREATE TABLE on every server start
 * while swallowing the errors, and ended up with two schemas that silently
 * diverged. Migrations are the only path by which this schema changes.
 *
 *   npm run migrate           apply all pending
 *   npm run migrate:status    show applied / pending, verify checksums
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface Migration {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      const version = filename.split('_')[0] ?? filename;
      return {
        version,
        filename,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

async function ensureLedger(client: pg.Client): Promise<void> {
  // The one table the runner itself owns. Everything else comes from a file.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(20)  PRIMARY KEY,
      filename   VARCHAR(200) NOT NULL,
      checksum   CHAR(64)     NOT NULL,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const statusOnly = process.argv.includes('--status');
  const migrations = loadMigrations();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await ensureLedger(client);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    // A changed checksum means an applied migration was edited in place.
    // That is how two environments silently diverge, so it is a hard error.
    let drift = false;
    for (const m of migrations) {
      const priorChecksum = applied.get(m.version);
      if (priorChecksum && priorChecksum !== m.checksum) {
        console.error(`CHECKSUM DRIFT  ${m.filename}`);
        console.error('  This migration was already applied, then edited.');
        console.error('  Write a new migration instead of editing an applied one.');
        drift = true;
      }
    }
    if (drift) process.exit(1);

    const pending = migrations.filter((m) => !applied.has(m.version));

    if (statusOnly) {
      for (const m of migrations) {
        console.log(`${applied.has(m.version) ? 'applied ' : 'PENDING '} ${m.filename}`);
      }
      console.log(`\n${applied.size} applied, ${pending.length} pending.`);
      return;
    }

    if (pending.length === 0) {
      console.log('Schema is up to date.');
      return;
    }

    for (const m of pending) {
      process.stdout.write(`applying ${m.filename} ... `);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
          [m.version, m.filename, m.checksum],
        );
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }
    console.log(`\n${pending.length} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
