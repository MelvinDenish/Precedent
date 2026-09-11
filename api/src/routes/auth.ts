/**
 * POST /auth/register, POST /auth/login, GET /auth/me.
 */
import '@fastify/jwt';
import type { FastifyInstance } from 'fastify';
import { loginSchema, registerSchema, type AuthResponse } from '@precedent/shared';
import { pool } from '../db.js';
import { badRequest, conflict, unauthorized } from '../errors.js';
import { authOf, makeRequireAuth } from '../auth/guard.js';
import { equalizeTiming, hashPassword, verifyPassword } from '../auth/password.js';
import type { JwtPayload } from '../types.js';

interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  university_id: string | null;
  regulation_id: string | null;
}

function toAuthUser(row: UserRow): AuthResponse['user'] {
  return {
    userId: String(row.user_id),
    email: row.email,
    displayName: row.display_name,
    universityId: row.university_id === null ? null : String(row.university_id),
    regulationId: row.regulation_id === null ? null : String(row.regulation_id),
  };
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const requireAuth = makeRequireAuth(app);

  const sign = (row: UserRow): string => {
    const payload: JwtPayload = { sub: String(row.user_id), email: row.email };
    return app.jwt.sign(payload);
  };

  app.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid registration payload.', parsed.error.flatten());
    }
    const input = parsed.data;

    // Stored lowercased so that two registrations differing only in case
    // cannot both succeed and then race each other at login.
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);

    let rows: UserRow[];
    try {
      ({ rows } = await pool.query<UserRow>(
        `INSERT INTO users
           (email, password_hash, display_name, university_id, regulation_id, college, dept)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING user_id, email, password_hash, display_name, university_id, regulation_id`,
        [
          email,
          passwordHash,
          input.displayName ?? null,
          input.universityId ?? null,
          input.regulationId ?? null,
          // Attributes, never corpus keys: including college or dept in the
          // corpus key would fragment the shared graph for no gain.
          input.college ?? null,
          input.dept ?? null,
        ],
      ));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('An account with that email already exists.');
      }
      throw err;
    }

    const row = rows[0];
    if (!row) throw new Error('register: insert returned no row');

    const body: AuthResponse = { token: sign(row), user: toAuthUser(row) };
    return reply.status(201).send(body);
  });

  app.post('/auth/login', async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid login payload.', parsed.error.flatten());

    const email = parsed.data.email.trim().toLowerCase();
    const { rows } = await pool.query<UserRow>(
      `SELECT user_id, email, password_hash, display_name, university_id, regulation_id
         FROM users WHERE email = $1`,
      [email],
    );

    const row = rows[0];
    if (!row) {
      // Same wording and the same cost as a wrong password: distinguishing
      // them tells an attacker which addresses are registered.
      await equalizeTiming();
      throw unauthorized('Email or password is incorrect.');
    }
    if (!(await verifyPassword(parsed.data.password, row.password_hash))) {
      throw unauthorized('Email or password is incorrect.');
    }

    const body: AuthResponse = { token: sign(row), user: toAuthUser(row) };
    return body;
  });

  app.get('/auth/me', { onRequest: requireAuth }, async (request) => {
    const { userId } = authOf(request);
    // Re-read rather than trusting the token body: the JWT is a bearer
    // identity, and display name or regulation may have changed since it was
    // issued (or the account may be gone).
    const { rows } = await pool.query<UserRow>(
      `SELECT user_id, email, password_hash, display_name, university_id, regulation_id
         FROM users WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw unauthorized('The account for this token no longer exists.');
    return toAuthUser(row);
  });
}
