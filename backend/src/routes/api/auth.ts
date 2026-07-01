import type { FastifyPluginAsync } from 'fastify';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import {
  createSession,
  destroySession,
  requireAuth,
} from '../../plugins/auth.js';

const credentialsSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: {
        type: 'string',
        maxLength: 254,
        pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
} as const;

type Credentials = { email: string; password: string };

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: Credentials }>(
    '/register',
    { schema: credentialsSchema },
    async (req, reply) => {
      const email = req.body.email.toLowerCase();
      const passwordHash = await hashPassword(req.body.password);

      const { rows } = await app.db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [email, passwordHash],
      );
      if (rows.length === 0) {
        return reply.code(409).send({ error: 'email already registered' });
      }

      await createSession(req, reply, rows[0]!.id);
      return reply.code(201).send({ id: rows[0]!.id, email });
    },
  );

  app.post<{ Body: Credentials }>(
    '/login',
    { schema: credentialsSchema },
    async (req, reply) => {
      const email = req.body.email.toLowerCase();
      const { rows } = await app.db.query<{
        id: string;
        password_hash: string;
      }>('SELECT id, password_hash FROM users WHERE email = $1', [email]);

      // Same response for unknown email and wrong password — don't leak
      // which emails have accounts.
      const ok =
        rows.length > 0 &&
        (await verifyPassword(req.body.password, rows[0]!.password_hash));
      if (!ok) {
        return reply.code(401).send({ error: 'invalid email or password' });
      }

      await createSession(req, reply, rows[0]!.id);
      return { id: rows[0]!.id, email };
    },
  );

  app.post('/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    return req.user;
  });
};
