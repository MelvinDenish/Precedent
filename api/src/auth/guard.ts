/**
 * Request authentication.
 *
 * Runs in onRequest rather than preHandler, and that ordering is load-bearing:
 * @fastify/rate-limit computes its key in onRequest too, so a preHandler guard
 * would leave request.user undefined at the moment the upload limiter needs it
 * and the limit would silently fall back to keying on IP -- which on a shared
 * campus NAT throttles an entire college as though it were one student.
 */
import '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { unauthorized } from '../errors.js';
import type { AuthenticatedUser, JwtPayload } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth. Absent on unauthenticated routes. */
    auth?: AuthenticatedUser;
  }
}

export function makeRequireAuth(app: FastifyInstance): onRequestHookHandler {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('A Bearer token is required.');
    }
    let payload: JwtPayload;
    try {
      payload = app.jwt.verify<JwtPayload>(header.slice('Bearer '.length));
    } catch {
      throw unauthorized('The token is invalid or has expired.');
    }
    request.auth = { userId: payload.sub, email: payload.email };
  };
}

/**
 * Narrows request.auth for handlers behind requireAuth. Throwing rather than
 * returning null keeps every call site free of a branch that cannot happen,
 * without reaching for a non-null assertion that would hide a routing mistake.
 */
export function authOf(request: FastifyRequest): AuthenticatedUser {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
