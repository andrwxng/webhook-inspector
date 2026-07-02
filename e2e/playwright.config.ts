import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * End-to-end test against the real stack: built frontend served by the
 * backend, Postgres + Redis from docker compose (or CI services).
 * Run `npm run build` first; the webServer below boots the compiled app.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env['CI'] ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:3100',
  },
  webServer: {
    command: 'npm run start --workspace backend',
    cwd: repoRoot,
    url: 'http://127.0.0.1:3100/healthz',
    reuseExistingServer: !process.env['CI'],
    env: { PORT: '3100' },
  },
});
