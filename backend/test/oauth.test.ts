import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, registerUser, resetDb } from './helpers.js';

/** Mock of the two GitHub hosts (oauth + api) in one server. */
async function startMockGithub(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/login/oauth/access_token') {
      res.end(JSON.stringify({ access_token: 'gh-token-123' }));
    } else if (req.url === '/user') {
      res.end(JSON.stringify({ id: 424242, email: null }));
    } else if (req.url === '/user/emails') {
      res.end(
        JSON.stringify([
          { email: 'unverified@example.com', primary: false, verified: false },
          { email: 'GH-User@Example.com', primary: true, verified: true },
        ]),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('GitHub OAuth', () => {
  let app: FastifyInstance;
  let mock: Awaited<ReturnType<typeof startMockGithub>>;

  beforeAll(async () => {
    mock = await startMockGithub();
    app = await buildTestApp({
      githubClientId: 'test-client-id',
      githubClientSecret: 'test-secret',
      githubOauthBase: mock.url,
      githubApiBase: mock.url,
    });
  });
  afterAll(async () => {
    await app.close();
    await mock.close();
  });
  beforeEach(async () => {
    await resetDb(app);
  });

  /** Runs /github to get the state cookie, then the callback with it. */
  async function completeOauthFlow(app: FastifyInstance) {
    const start = await app.inject({ method: 'GET', url: '/api/auth/github' });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get('state')!;
    const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')!;

    return app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=fake-code&state=${state}`,
      cookies: { oauth_state: stateCookie.value },
    });
  }

  it('redirects to GitHub with client id and a state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(res.cookies.some((c) => c.name === 'oauth_state')).toBe(true);
  });

  it('creates a user from the verified primary email and starts a session', async () => {
    const callback = await completeOauthFlow(app);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    const sid = callback.cookies.find((c) => c.name === 'sid');
    expect(sid).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { sid: sid!.value },
    });
    expect(me.json()).toMatchObject({ email: 'gh-user@example.com' });
  });

  it('links to an existing password account with the same email', async () => {
    await registerUser(app, 'gh-user@example.com', 'password123');

    const callback = await completeOauthFlow(app);
    expect(callback.statusCode).toBe(302);

    // still exactly one user, now with github_id attached
    const { rows } = await app.db.query(
      'SELECT github_id FROM users WHERE email = $1',
      ['gh-user@example.com'],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].github_id)).toBe(424242);

    // and the original password still works
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'gh-user@example.com', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects a state mismatch (CSRF)', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/github' });
    const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')!;
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?code=fake-code&state=attacker-state',
      cookies: { oauth_state: stateCookie.value },
    });
    expect(res.statusCode).toBe(401);
  });

  it('passwordless OAuth accounts cannot password-login', async () => {
    await completeOauthFlow(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'gh-user@example.com', password: 'password123' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('404s when OAuth is not configured', async () => {
    const bare = await buildTestApp(); // no client id
    try {
      const res = await bare.inject({ method: 'GET', url: '/api/auth/github' });
      expect(res.statusCode).toBe(404);
      const providers = await bare.inject({
        method: 'GET',
        url: '/api/auth/providers',
      });
      expect(providers.json()).toEqual({ github: false });
    } finally {
      await bare.close();
    }
  });
});
