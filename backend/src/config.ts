export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Cookies are Secure-only in production (HTTPS on Railway). */
  cookieSecure: boolean;
}

const DEV_DATABASE_URL =
  'postgres://webhook:webhook@localhost:5432/webhook_inspector';

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
  };
}
