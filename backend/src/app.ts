import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { loadConfig, type Config } from './config.js';
import {
  InProcessRequestBus,
  RedisRequestBus,
  type RequestBus,
} from './events.js';
import { RateLimiter } from './lib/rate-limit.js';
import { Replayer } from './lib/replay.js';
import { apiRoutes } from './routes/api/index.js';
import { ingestRoutes } from './routes/ingest.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: pg.Pool;
    config: Config;
    bus: RequestBus;
    /** null when Redis is not configured — ingest then skips rate limiting. */
    rateLimiter: RateLimiter | null;
    replayer: Replayer;
  }
}

export interface BuildAppOptions {
  databaseUrl?: string;
  logger?: boolean;
  configOverrides?: Partial<Config>;
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
  const config: Config = {
    ...loadConfig(),
    ...(opts.databaseUrl ? { databaseUrl: opts.databaseUrl } : {}),
    ...opts.configOverrides,
  };

  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true, // Railway/most PaaS terminate TLS in front of us
    // SSE connections stay open forever; without this, close() would hang
    // waiting for them (tests, and graceful shutdown on deploys).
    forceCloseConnections: true,
    // Slowloris guard: the entire request (headers + body) must arrive
    // within this window. Response streaming (SSE) is unaffected.
    requestTimeout: 15_000,
  });

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  app.decorate('db', pool);
  app.decorate('config', config);

  let redis: Redis | null = null;
  let subscriber: Redis | null = null;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, {
      // If Redis is down, fail checks *immediately* instead of queueing
      // commands — the ingest handler catches the error and fails open.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    // Connection errors surface as failed commands (handled at call sites);
    // without a listener each one would also crash the process.
    redis.on('error', () => {});
    app.decorate(
      'rateLimiter',
      new RateLimiter(redis, config.ingestRateLimit, config.ingestRateWindowSec),
    );

    // Dedicated subscriber connection (subscribe mode blocks other
    // commands). Offline queue stays ON here so subscriptions survive
    // reconnects — ioredis re-subscribes automatically.
    subscriber = new Redis(config.redisUrl, {
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    subscriber.on('error', () => {});
    app.decorate(
      'bus',
      new RedisRequestBus(redis, subscriber, (err, context) =>
        app.log.warn({ err }, `request bus: ${context}`),
      ),
    );
  } else {
    app.decorate('rateLimiter', null);
    app.decorate('bus', new InProcessRequestBus());
    app.log.warn(
      'REDIS_URL not set — rate limiting DISABLED, live events are single-instance only',
    );
  }

  app.decorate(
    'replayer',
    new Replayer({
      timeoutMs: config.replayTimeoutMs,
      maxResponseBytes: config.replayMaxResponseBytes,
      allowPrivate: config.replayAllowPrivate,
    }),
  );

  app.addHook('onClose', async () => {
    redis?.disconnect();
    subscriber?.disconnect();
    await app.replayer.close();
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
