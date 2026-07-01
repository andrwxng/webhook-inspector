import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { generateSessionToken } from '../lib/ids.js';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_DAYS = 30;

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string } | null;
  }
}

// Only the SHA-256 of the token is stored, so a leaked DB dump can't be
// replayed as live sessions.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const token = generateSessionToken();
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await req.server.db.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expiresAt],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.server.config.cookieSecure,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    await req.server.db.query('DELETE FROM sessions WHERE token_hash = $1', [
      hashToken(token),
    ]);
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** preHandler for viewer routes: resolves the session cookie to a user or 401s. */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) {
    return reply.code(401).send({ error: 'not authenticated' });
  }
  const { rows } = await req.server.db.query<{ id: string; email: string }>(
    `SELECT u.id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (rows.length === 0) {
    return reply.code(401).send({ error: 'not authenticated' });
  }
  req.user = rows[0]!;
}
