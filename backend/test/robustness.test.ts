import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cleanupOnce } from '../src/lib/retention.js';
import { buildTestApp, registerUser, resetDb } from './helpers.js';

async function createEndpoint(
  app: FastifyInstance,
  cookies: Record<string, string>,
): Promise<{ id: string; slug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/endpoints',
    cookies,
    payload: {},
  });
  return res.json();
}

async function storedCount(
  app: FastifyInstance,
  endpointId: string,
): Promise<number> {
  const { rows } = await app.db.query<{ n: string }>(
    'SELECT count(*) AS n FROM requests WHERE endpoint_id = $1',
    [endpointId],
  );
  return Number(rows[0]!.n);
}

describe('ingest body-size limit', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp({ ingestBodyLimitBytes: 1024 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
  });

  it('rejects oversized bodies with 413 and stores nothing', async () => {
    const { cookies } = await registerUser(app);
    const { id, slug } = await createEndpoint(app, cookies);

    const res = await app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2048, 0x41),
    });
    expect(res.statusCode).toBe(413);
    expect(await storedCount(app, id)).toBe(0);
  });

  it('accepts bodies at the limit', async () => {
    const { cookies } = await registerUser(app);
    const { id, slug } = await createEndpoint(app, cookies);

    const res = await app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1024, 0x41),
    });
    expect(res.statusCode).toBe(200);
    expect(await storedCount(app, id)).toBe(1);
  });

  it('does not affect the viewer API (register still works)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'viewer@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('ingest rate limiting (Redis fixed window)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp({ ingestRateLimit: 3, ingestRateWindowSec: 1 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
  });

  it('sheds with 429 above the limit and recovers after the window', async () => {
    const { cookies } = await registerUser(app);
    const { id, slug } = await createEndpoint(app, cookies);

    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: 'GET', url: `/in/${slug}/n${i}` });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: 'GET', url: `/in/${slug}/n4` });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // shed means shed: the request was not stored
    expect(await storedCount(app, id)).toBe(3);

    // a fresh window admits traffic again
    await new Promise((r) => setTimeout(r, 1100));
    const recovered = await app.inject({
      method: 'GET',
      url: `/in/${slug}/n5`,
    });
    expect(recovered.statusCode).toBe(200);
  });

  it('limits endpoints independently', async () => {
    const { cookies } = await registerUser(app);
    const a = await createEndpoint(app, cookies);
    const b = await createEndpoint(app, cookies);

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: `/in/${a.slug}/x` });
    }
    expect(
      (await app.inject({ method: 'GET', url: `/in/${a.slug}/x` })).statusCode,
    ).toBe(429);
    // endpoint B is unaffected by A's flood
    expect(
      (await app.inject({ method: 'GET', url: `/in/${b.slug}/x` })).statusCode,
    ).toBe(200);
  });

  it('fails OPEN when Redis is unreachable', async () => {
    const deadRedisApp = await buildTestApp({
      redisUrl: 'redis://127.0.0.1:6399', // nothing listens here
      ingestRateLimit: 1,
    });
    try {
      const { cookies } = await registerUser(deadRedisApp, 'dead@example.com');
      const { id, slug } = await createEndpoint(deadRedisApp, cookies);

      // Far past the limit — but with Redis down, capture must win.
      for (let i = 0; i < 4; i++) {
        const res = await deadRedisApp.inject({
          method: 'GET',
          url: `/in/${slug}/r${i}`,
        });
        expect(res.statusCode).toBe(200);
      }
      expect(await storedCount(deadRedisApp, id)).toBe(4);
    } finally {
      await deadRedisApp.close();
    }
  });
});

describe('retention cleanup', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(app);
  });

  async function seedRequest(
    endpointId: string,
    path: string,
    ageDays: number,
  ): Promise<void> {
    await app.db.query(
      `INSERT INTO requests (endpoint_id, method, path, received_at)
       VALUES ($1, 'GET', $2, now() - make_interval(days => $3))`,
      [endpointId, path, ageDays],
    );
  }

  it('deletes requests past max age', async () => {
    const { cookies } = await registerUser(app);
    const { id } = await createEndpoint(app, cookies);
    await seedRequest(id, '/fresh', 0);
    await seedRequest(id, '/stale', 10);
    await seedRequest(id, '/ancient', 30);

    const result = await cleanupOnce(app.db, {
      retentionMaxAgeDays: 7,
      retentionMaxPerEndpoint: 100,
    });

    expect(result.skipped).toBe(false);
    expect(result.oldRequests).toBe(2);
    const { rows } = await app.db.query(
      'SELECT path FROM requests WHERE endpoint_id = $1',
      [id],
    );
    expect(rows.map((r) => r.path)).toEqual(['/fresh']);
  });

  it('caps each endpoint at N newest, independently', async () => {
    const { cookies } = await registerUser(app);
    const a = await createEndpoint(app, cookies);
    const b = await createEndpoint(app, cookies);
    // a: 4 requests aged 3,2,1,0 days; b: 1 request
    for (let age = 3; age >= 0; age--) await seedRequest(a.id, `/a${age}`, age);
    await seedRequest(b.id, '/b0', 0);

    const result = await cleanupOnce(app.db, {
      retentionMaxAgeDays: 30,
      retentionMaxPerEndpoint: 2,
    });

    expect(result.excessRequests).toBe(2);
    const { rows } = await app.db.query(
      'SELECT path FROM requests WHERE endpoint_id = $1 ORDER BY received_at DESC',
      [a.id],
    );
    // the two NEWEST survive
    expect(rows.map((r) => r.path)).toEqual(['/a0', '/a1']);
    expect(await storedCount(app, b.id)).toBe(1);
  });

  it('deletes expired sessions but keeps live ones', async () => {
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('s@example.com', 'x')
       RETURNING id`,
    );
    const userId = rows[0]!.id;
    await app.db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, 'expired', now() - interval '1 day'),
              ($1, 'live', now() + interval '1 day')`,
      [userId],
    );

    const result = await cleanupOnce(app.db, {
      retentionMaxAgeDays: 7,
      retentionMaxPerEndpoint: 100,
    });

    expect(result.expiredSessions).toBe(1);
    const left = await app.db.query('SELECT token_hash FROM sessions');
    expect(left.rows.map((r) => r.token_hash)).toEqual(['live']);
  });

  it('skips when another instance holds the cleanup lock', async () => {
    const rival = await app.db.connect();
    try {
      await rival.query('SELECT pg_advisory_lock(723002)');
      const result = await cleanupOnce(app.db, {
        retentionMaxAgeDays: 7,
        retentionMaxPerEndpoint: 100,
      });
      expect(result.skipped).toBe(true);
    } finally {
      await rival.query('SELECT pg_advisory_unlock(723002)');
      rival.release();
    }
  });
});
