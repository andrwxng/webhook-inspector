export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Cookies are Secure-only in production (HTTPS on Railway). */
  cookieSecure: boolean;
  /** null disables Redis-backed features (ingest rate limiting), with a warning. */
  redisUrl: string | null;
  /** Max ingest body size; larger payloads get 413 and are not stored. */
  ingestBodyLimitBytes: number;
  /** Fixed-window rate limit per endpoint on the ingest path. */
  ingestRateLimit: number;
  ingestRateWindowSec: number;
  /** Retention: keep at most N requests per endpoint, none older than D days. */
  retentionMaxPerEndpoint: number;
  retentionMaxAgeDays: number;
  cleanupIntervalSec: number;
  /** Replay/forward: total timeout and response-preview cap. */
  replayTimeoutMs: number;
  replayMaxResponseBytes: number;
  /**
   * Allow replay/forward targets on private/internal addresses. OFF by
   * default (SSRF guard); set REPLAY_ALLOW_PRIVATE=1 for local dev where
   * replaying to localhost is the point.
   */
  replayAllowPrivate: boolean;
  /** GitHub OAuth; both null disables it (the login button hides). */
  githubClientId: string | null;
  githubClientSecret: string | null;
  /** Overridable so tests can point OAuth at a mock server. */
  githubOauthBase: string;
  githubApiBase: string;
}

const DEV_DATABASE_URL =
  'postgres://webhook:webhook@localhost:5432/webhook_inspector';
const DEV_REDIS_URL = 'redis://localhost:6379';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): Config {
  const isProd = process.env['NODE_ENV'] === 'production';
  const databaseUrl = process.env['DATABASE_URL'];

  if (isProd && !databaseUrl) {
    throw new Error('DATABASE_URL is required in production');
  }

  return {
    port: Number(process.env['PORT'] ?? 3000),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl: databaseUrl ?? DEV_DATABASE_URL,
    cookieSecure: isProd,
    redisUrl: process.env['REDIS_URL'] ?? (isProd ? null : DEV_REDIS_URL),
    ingestBodyLimitBytes: intEnv('INGEST_BODY_LIMIT_BYTES', 1024 * 1024),
    ingestRateLimit: intEnv('INGEST_RATE_LIMIT', 120),
    ingestRateWindowSec: intEnv('INGEST_RATE_WINDOW_SEC', 60),
    retentionMaxPerEndpoint: intEnv('RETENTION_MAX_PER_ENDPOINT', 500),
    retentionMaxAgeDays: intEnv('RETENTION_MAX_AGE_DAYS', 7),
    cleanupIntervalSec: intEnv('CLEANUP_INTERVAL_SEC', 600),
    replayTimeoutMs: intEnv('REPLAY_TIMEOUT_MS', 10_000),
    replayMaxResponseBytes: intEnv('REPLAY_MAX_RESPONSE_BYTES', 65_536),
    replayAllowPrivate: process.env['REPLAY_ALLOW_PRIVATE'] === '1',
    githubClientId: process.env['GITHUB_CLIENT_ID'] ?? null,
    githubClientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? null,
    githubOauthBase: process.env['GITHUB_OAUTH_BASE'] ?? 'https://github.com',
    githubApiBase: process.env['GITHUB_API_BASE'] ?? 'https://api.github.com',
  };
}
