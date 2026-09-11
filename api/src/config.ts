/**
 * Configuration, read from the environment only.
 *
 * There is no hardcoded fallback secret anywhere in this codebase. A server
 * that boots with a default JWT secret is a server that ships one.
 */
import './env.js'; // must precede every read below; see env.ts

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in; ` +
        'the API deliberately refuses to boot with a default.',
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '3000')),
  logLevel: optional('LOG_LEVEL', 'info'),

  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),

  /** CORS is restricted to this origin. No wildcard, in any environment. */
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),

  blob: {
    driver: optional('BLOB_DRIVER', 'local') as 'local' | 's3',
    localDir: optional('BLOB_LOCAL_DIR', './.blobs'),
    bucket: process.env.S3_BUCKET ?? null,
    region: optional('S3_REGION', 'ap-south-1'),
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? null,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    /** Overridable so the S3 driver can be pointed at MinIO or a test double. */
    endpoint: process.env.S3_ENDPOINT ?? null,
  },

  upload: {
    maxBytes: Number(optional('UPLOAD_MAX_BYTES', String(32 * 1024 * 1024))),
    /** Per user, not per IP: a shared campus NAT would otherwise rate-limit a whole college. */
    ratePerWindow: Number(optional('UPLOAD_RATE_MAX', '20')),
    rateWindow: optional('UPLOAD_RATE_WINDOW', '1 minute'),
  },

  queue: {
    /** Capped attempts, then dead-letter. */
    attempts: Number(optional('QUEUE_ATTEMPTS', '5')),
    backoffDelayMs: Number(optional('QUEUE_BACKOFF_MS', '2000')),
    /** Fraction of the computed delay randomised away, to break retry convoys. */
    backoffJitter: Number(optional('QUEUE_BACKOFF_JITTER', '0.5')),
  },
} as const;

export type Config = typeof config;
