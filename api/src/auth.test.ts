/**
 * Auth round trip: register -> login -> me.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApiError, AuthResponse } from '@precedent/shared';
import { pool } from './db.js';
import { closeQueues } from './queue/index.js';
import { buildTestServer, type TestUser } from './testing.js';

let app: FastifyInstance;
const createdUserIds: string[] = [];

const password = 'a-sufficiently-long-password';
let sequence = 0;
const freshEmail = (): string => `auth-${process.pid}-${Date.now()}-${sequence++}@example.edu`;

async function register(
  email: string,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: AuthResponse & ApiError }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password, displayName: 'Test Student', ...overrides },
  });
  const body = response.json() as AuthResponse & ApiError;
  if (body.user?.userId) createdUserIds.push(body.user.userId);
  return { status: response.statusCode, body };
}

beforeAll(async () => {
  app = await buildTestServer();
  await app.ready();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
  }
  await app.close();
  await closeQueues();
});

describe('auth round trip', () => {
  it('registers, logs in, and returns the same identity from /auth/me', async () => {
    const email = freshEmail();

    const registered = await register(email);
    expect(registered.status).toBe(201);
    expect(registered.body.token).toBeTruthy();
    expect(registered.body.user.email).toBe(email);
    expect(registered.body.user.displayName).toBe('Test Student');

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json() as AuthResponse;
    expect(loginBody.user.userId).toBe(registered.body.user.userId);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      userId: registered.body.user.userId,
      email,
      displayName: 'Test Student',
    });
  });

  it('treats the email case-insensitively', async () => {
    const email = freshEmail();
    await register(email);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email.toUpperCase(), password },
    });
    expect(login.statusCode).toBe(200);
  });

  it('never stores the password in plaintext', async () => {
    const email = freshEmail();
    const registered = await register(email);

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [registered.body.user.userId],
    );
    const stored = rows[0]!.password_hash;
    expect(stored).not.toContain(password);
    expect(stored.startsWith('$2')).toBe(true); // bcrypt
  });
});

describe('auth failures', () => {
  it('rejects a duplicate email with 409', async () => {
    const email = freshEmail();
    expect((await register(email)).status).toBe(201);
    expect((await register(email)).status).toBe(409);
  });

  it('rejects a password shorter than the schema allows', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: freshEmail(), password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a wrong password, and says nothing about whether the email exists', async () => {
    const email = freshEmail();
    await register(email);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'not-the-right-password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: freshEmail(), password },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Identical responses: a difference here enumerates the user table.
    expect((wrongPassword.json() as ApiError).error.message).toBe(
      (unknownEmail.json() as ApiError).error.message,
    );
  });

  it('rejects /auth/me without a token, with a malformed token, and with a forged one', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer not-a-jwt' },
      { authorization: 'Basic abc' },
      // Correctly shaped but signed with a different secret.
      {
        authorization:
          'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
          'eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIn0.' +
          'Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtdmFsaWQ',
      },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects a token whose account has been deleted', async () => {
    const email = freshEmail();
    const registered = await register(email);
    const user: TestUser = {
      userId: registered.body.user.userId,
      email,
      token: registered.body.token,
    };

    await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${user.token}` },
    });
    // The token still verifies; the account behind it does not exist. A JWT
    // is an identity claim, not an authorization cache.
    expect(me.statusCode).toBe(401);
  });
});
