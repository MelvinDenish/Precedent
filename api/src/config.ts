/**
 * Configuration, read from the environment only.
 *
 * There is no hardcoded fallback secret anywhere in this codebase. A server
 * that boots with a default JWT secret is a server that ships one.
 */

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
  },
} as const;

export type Config = typeof config;
