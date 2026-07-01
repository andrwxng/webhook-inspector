import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, registerUser, resetDb } from './helpers.js';

describe('auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('registers a user and starts a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'a@b.com' });
    expect(res.cookies.some((c) => c.name === 'sid')).toBe(true);
  });

  it('rejects duplicate registration', async () => {
    await registerUser(app, 'a@b.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects short passwords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('logs in with correct credentials, rejects wrong ones', async () => {
    await registerUser(app, 'a@b.com', 'password123');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com', password: 'wrongpassword' },
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com', password: 'password123' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.cookies.some((c) => c.name === 'sid')).toBe(true);
  });

  it('me returns the user with a session, 401 without', async () => {
    const { cookies } = await registerUser(app, 'a@b.com');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'a@b.com' });

    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
  });

  it('logout invalidates the session server-side', async () => {
    const { cookies } = await registerUser(app, 'a@b.com');
    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });

    // Same cookie replayed after logout must be dead (revocation works).
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(me.statusCode).toBe(401);
  });
});
