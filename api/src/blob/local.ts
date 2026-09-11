/**
 * Filesystem blob driver. Used in development and by the test suite.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlobDriver, PutResult } from './driver.js';

export class LocalBlobDriver implements BlobDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  }

  private pathFor(key: string): string {
    // Keys are built by blobKey() from ids and hex hashes, never from a
    // filename, so they cannot contain traversal segments. Resolved and
    // re-checked anyway: a path escape here writes attacker bytes anywhere
    // the process can reach.
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`blob key escapes the blob root: ${key}`);
    }
    return full;
  }

  async putIfAbsent(key: string, bytes: Buffer): Promise<PutResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      // wx makes create-or-fail one atomic syscall; a stat-then-write pair
      // would let two concurrent uploads of one paper both decide to write.
      await writeFile(path, bytes, { flag: 'wx' });
      return { url: pathToFileURL(path).href, created: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { url: pathToFileURL(path).href, created: false };
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }
}
