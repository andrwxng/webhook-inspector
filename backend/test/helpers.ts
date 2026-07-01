import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TEST_DATABASE_URL } from './setup/test-db.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp({ databaseUrl: TEST_DATABASE_URL, logger: false });
}

export async function resetDb(app: FastifyInstance): Promise<void> {
  // users cascades to sessions and endpoints; endpoints cascades to requests.
  await app.db.query('TRUNCATE users CASCADE');
}

/** Register a user and return the session cookie for authenticated injects. */
export async function registerUser(
  app: FastifyInstance,
  email = 'test@example.com',
  password = 'password123',
): Promise<{ cookies: Record<string, string> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const sid = res.cookies.find((c) => c.name === 'sid');
  if (!sid) throw new Error('no session cookie set');
  return { cookies: { sid: sid.value } };
}
