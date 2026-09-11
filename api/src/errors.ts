/**
 * Errors that reach the client as the contract's ApiError shape.
 *
 * Anything not thrown as an HttpError is a bug, not a client mistake, so the
 * handler reports it as a generic 500 and logs the detail rather than echoing
 * an internal message (and possibly a SQL fragment) back over the wire.
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError } from '@precedent/shared';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required.'): HttpError =>
  new HttpError(401, 'unauthorized', message);

export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);

export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);

export const payloadTooLarge = (message: string): HttpError =>
  new HttpError(413, 'payload_too_large', message);

export const unsupportedMedia = (message: string): HttpError =>
  new HttpError(415, 'unsupported_media_type', message);

function body(code: string, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.statusCode).send(body(err.code, err.message, err.details));
      return;
    }

    // Fastify's own typed failures (validation, body limit, multipart) carry a
    // statusCode; anything 4xx is the caller's problem and safe to echo.
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      void reply
        .status(statusCode)
        .send(body(err.code ?? 'bad_request', err.message));
      return;
    }

    request.log.error({ err }, 'unhandled error');
    void reply.status(500).send(body('internal_error', 'Internal server error.'));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(body('not_found', `No route for ${request.method} ${request.url}.`));
  });
}
