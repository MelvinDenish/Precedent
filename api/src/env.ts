/**
 * Loads .env into process.env as a side effect, once, before config reads it.
 *
 * Imported as the FIRST line of config.ts rather than by each entrypoint:
 * config.ts throws on a missing JWT_SECRET at module-evaluation time, so any
 * consumer that forgot the loader would fail. Putting it here makes the
 * ordering a property of the module graph instead of per-file discipline that
 * an import reorder breaks silently.
 *
 * Platform environment always wins. A var already present is never replaced,
 * so a deployed container's real secrets cannot be shadowed by a stray .env
 * that got copied into the image.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from this file to the repo root, where .env lives. */
function findEnvFile(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parse(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out.set(key, value);
  }
  return out;
}

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = findEnvFile();
  if (!file) return; // deployed environments inject vars directly; absence is normal
  for (const [key, value] of parse(readFileSync(file, 'utf8'))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();
