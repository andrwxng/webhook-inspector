import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { createSession } from '../../plugins/auth.js';

const STATE_COOKIE = 'oauth_state';

/**
 * GitHub OAuth (authorization-code flow).
 *
 * GET /api/auth/github          → set a state cookie, redirect to GitHub
 * GET /api/auth/github/callback → verify state, exchange the code, find
 *                                 or create the user, start a session
 *
 * The state cookie is the CSRF guard: the callback only proceeds when the
 * state GitHub echoes back matches the one we set on this browser.
 * Account linking: an existing account with the same (GitHub-verified)
 * email gets github_id attached rather than a duplicate account.
 */
export const githubOauthRoutes: FastifyPluginAsync = async (app) => {
  const cfg = app.config;

  app.get('/github', async (req, reply) => {
    if (!cfg.githubClientId) {
      return reply.code(404).send({ error: 'GitHub OAuth is not configured' });
    }
    const state = randomBytes(16).toString('hex');
    reply.setCookie(STATE_COOKIE, state, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.cookieSecure,
      maxAge: 600,
    });
    const redirectUri = `${req.protocol}://${req.headers.host}/api/auth/github/callback`;
    const url = new URL('/login/oauth/authorize', cfg.githubOauthBase);
    url.searchParams.set('client_id', cfg.githubClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'user:email');
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/github/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: 256 },
            state: { type: 'string', maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!cfg.githubClientId || !cfg.githubClientSecret) {
        return reply.code(404).send({ error: 'GitHub OAuth is not configured' });
      }
      const expected = req.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: '/' });
      if (
        !req.query.code ||
        !req.query.state ||
        !expected ||
        expected !== req.query.state
      ) {
        return reply.code(401).send({ error: 'invalid oauth state' });
      }

      try {
        const tokenRes = await fetch(
          `${cfg.githubOauthBase}/login/oauth/access_token`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              client_id: cfg.githubClientId,
              client_secret: cfg.githubClientSecret,
              code: req.query.code,
            }),
          },
        );
        const token = (await tokenRes.json()) as { access_token?: string };
        if (!token.access_token) throw new Error('no access token in response');

        const ghHeaders = {
          authorization: `Bearer ${token.access_token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'webhook-inspector',
        };
        const userRes = await fetch(`${cfg.githubApiBase}/user`, {
          headers: ghHeaders,
        });
        const ghUser = (await userRes.json()) as {
          id: number;
          email: string | null;
        };

        // The profile email can be private/absent; ask the emails API and
        // accept only VERIFIED addresses (linking hinges on this).
        let email = ghUser.email;
        if (!email) {
          const emailsRes = await fetch(`${cfg.githubApiBase}/user/emails`, {
            headers: ghHeaders,
          });
          const emails = (await emailsRes.json()) as Array<{
            email: string;
            primary: boolean;
            verified: boolean;
          }>;
          email =
            emails.find((e) => e.primary && e.verified)?.email ??
            emails.find((e) => e.verified)?.email ??
            null;
        }
        if (!email) {
          return reply
            .code(400)
            .send({ error: 'no verified email on the GitHub account' });
        }

        const userId = await findOrCreateUser(
          app.db,
          ghUser.id,
          email.toLowerCase(),
        );
        await createSession(req, reply, userId);
        return reply.redirect('/');
      } catch (err) {
        req.log.warn({ err }, 'github oauth failed');
        return reply.code(502).send({ error: 'github oauth failed' });
      }
    },
  );
};

async function findOrCreateUser(
  db: pg.Pool,
  githubId: number,
  email: string,
): Promise<string> {
  const byGithub = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE github_id = $1',
    [githubId],
  );
  if (byGithub.rows.length > 0) return byGithub.rows[0]!.id;

  // Same verified email → link, don't duplicate.
  const linked = await db.query<{ id: string }>(
    'UPDATE users SET github_id = $1 WHERE email = $2 RETURNING id',
    [githubId, email],
  );
  if (linked.rows.length > 0) return linked.rows[0]!.id;

  const created = await db.query<{ id: string }>(
    'INSERT INTO users (email, github_id) VALUES ($1, $2) RETURNING id',
    [email, githubId],
  );
  return created.rows[0]!.id;
}
