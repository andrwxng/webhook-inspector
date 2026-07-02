import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig, type Config } from './config.js';
import { InProcessRequestBus, type RequestBus } from './events.js';
import { apiRoutes } from './routes/api/index.js';
import { ingestRoutes } from './routes/ingest.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: pg.Pool;
    config: Config;
    bus: RequestBus;
  }
}

export interface BuildAppOptions {
  databaseUrl?: string;
  logger?: boolean;
}

/**
 * Builds the Fastify app without binding to a port, so tests can exercise
 * routes via app.inject() and the entrypoint (index.ts) stays trivial.
 *
 * Route layout — the ingest/viewer split:
 *   /healthz — liveness probe, no auth, no dependencies
 *   /in/*    — ingest path: untrusted webhook traffic, raw-byte capture
 *   /api/*   — viewer path: cookie-authenticated dashboard API
 *   /*       — built frontend (production only, when frontend/dist exists)
 */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = loadConfig();
  if (opts.databaseUrl) config.databaseUrl = opts.databaseUrl;

  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true, // Railway/most PaaS terminate TLS in front of us
    // SSE connections stay open forever; without this, close() would hang
    // waiting for them (tests, and graceful shutdown on deploys).
    forceCloseConnections: true,
  });

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  app.decorate('db', pool);
  app.decorate('config', config);
  app.decorate('bus', new InProcessRequestBus());
  app.addHook('onClose', async () => {
    await pool.end();
  });

  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  await app.register(ingestRoutes, { prefix: '/in' });
  await app.register(apiRoutes, { prefix: '/api' });

  // In production the backend serves the built frontend, so one Railway
  // service hosts everything and the browser never needs CORS.
  const staticDir =
    process.env['STATIC_DIR'] ??
    fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api') &&
        !req.url.startsWith('/in/')
      ) {
        return reply.sendFile('index.html'); // SPA fallback
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
