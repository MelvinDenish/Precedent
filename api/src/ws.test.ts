/**
 * The progress socket as a client actually reaches it.
 *
 * The hub is unit-tested in infra.test.ts; what is under test here is the
 * route: the handshake, the token check, and the subscribe protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { closeQueues } from './queue/index.js';
import { CLOSE_UNAUTHORIZED } from './ws/progress.js';
import { buildTestServer, registerUser, type TestUser } from './testing.js';

let app: FastifyInstance;
let user: TestUser;

/**
 * Structural, because `ws` ships no type declarations and @types/ws is not
 * installed -- adding it would mean touching the root lockfile mid-wave.
 */
interface ClientSocket {
  send(data: string): void;
  terminate(): void;
  once(event: 'message', cb: (raw: Buffer) => void): void;
  once(event: 'close', cb: (code: number) => void): void;
}

interface Connection {
  send(data: string): void;
  terminate(): void;
  /** The next frame, buffered if it arrived before this call. */
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  /** The close code, if the socket has closed or closes later. */
  closeCode(timeoutMs?: number): Promise<number>;
}

/**
 * Listeners are attached through injectWS's onInit, which runs before the
 * handshake completes. Attaching them after `await injectWS(...)` loses any
 * frame the server sent on connection -- and the rejection path sends its
 * frame immediately, so that race is exactly the case under test.
 */
async function connect(app: FastifyInstance, url: string): Promise<Connection> {
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  let closeCode: number | null = null;
  const closeWaiters: ((code: number) => void)[] = [];

  const socket = (await app.injectWS(url, undefined, {
    onInit: (ws: unknown) => {
      const raw = ws as {
        on(event: string, cb: (...args: never[]) => void): void;
      };
      raw.on('message', ((data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }) as (...args: never[]) => void);
      raw.on('close', ((code: number) => {
        closeCode = code;
        for (const waiter of closeWaiters.splice(0)) waiter(code);
      }) as (...args: never[]) => void);
    },
  })) as unknown as ClientSocket;

  return {
    send: (data) => socket.send(data),
    terminate: () => socket.terminate(),
    next: (timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const buffered = frames.shift();
        if (buffered) return resolve(buffered);
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    closeCode: (timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        if (closeCode !== null) return resolve(closeCode);
        const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
        closeWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
  };
}

beforeAll(async () => {
  app = await buildTestServer();
  await app.ready();
  user = await registerUser(app, 'socket');
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
  await app.close();
  await closeQueues();
});

describe('GET /ws', () => {
  it('subscribes to a paper channel and acknowledges', async () => {
    const socket = await connect(app, `/api/v1/ws?token=${user.token}`);
    try {
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'paper:42' }));
      expect(await socket.next()).toEqual({ type: 'subscribed', channel: 'paper:42' });

      socket.send(JSON.stringify({ type: 'ping' }));
      expect(await socket.next()).toEqual({ type: 'pong' });

      socket.send(JSON.stringify({ type: 'unsubscribe', channel: 'paper:42' }));
      expect(await socket.next()).toEqual({ type: 'unsubscribed', channel: 'paper:42' });
    } finally {
      socket.terminate();
    }
  });

  it('rejects a connection without a valid token', async () => {
    for (const query of ['', '?token=', '?token=not-a-jwt']) {
      const socket = await connect(app, `/api/v1/ws${query}`);
      const frame = await socket.next();
      expect(frame['type']).toBe('error');
      expect(String(frame['message'])).toMatch(/token/i);
      // The rejection frame is flushed before the close, so the client is
      // told why rather than seeing the socket vanish.
      expect(await socket.closeCode()).toBe(CLOSE_UNAUTHORIZED);
    }
  });

  it('refuses a channel outside the paper namespace', async () => {
    const socket = await connect(app, `/api/v1/ws?token=${user.token}`);
    try {
      // Clients may only watch papers; anything else would be a client
      // guessing at an internal namespace.
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'user:1' }));
      expect((await socket.next())['type']).toBe('error');
    } finally {
      socket.terminate();
    }
  });

  it('reports a malformed frame instead of closing the socket', async () => {
    const socket = await connect(app, `/api/v1/ws?token=${user.token}`);
    try {
      socket.send('this is not json');
      expect((await socket.next())['type']).toBe('error');

      // Still usable afterwards.
      socket.send(JSON.stringify({ type: 'ping' }));
      expect((await socket.next())['type']).toBe('pong');
    } finally {
      socket.terminate();
    }
  });
});
