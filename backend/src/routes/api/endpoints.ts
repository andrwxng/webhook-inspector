import type { FastifyPluginAsync } from 'fastify';
import { generateSlug } from '../../lib/ids.js';
import { requireAuth } from '../../plugins/auth.js';

const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export const endpointRoutes: FastifyPluginAsync = async (app) => {
  // Everything under /api/endpoints requires a logged-in user.
  app.addHook('preHandler', requireAuth);

  app.post<{ Body: { name?: string } | null }>(
    '/',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      const name = req.body?.name ?? null;
      // Slug collisions are ~impossible (60 bits of randomness); the unique
      // constraint is the backstop. One retry covers the astronomical case.
      for (let attempt = 0; attempt < 2; attempt++) {
        const slug = generateSlug();
        const { rows } = await app.db.query<{
          id: string;
          slug: string;
          name: string | null;
          created_at: string;
        }>(
          `INSERT INTO endpoints (user_id, slug, name) VALUES ($1, $2, $3)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id, slug, name, created_at`,
          [req.user!.id, slug, name],
        );
        if (rows.length > 0) {
          return reply.code(201).send(rows[0]);
        }
      }
      return reply.code(500).send({ error: 'could not allocate slug' });
    },
  );

  app.get('/', async (req) => {
    const { rows } = await app.db.query(
      `SELECT e.id, e.slug, e.name, e.created_at,
              count(r.id)::int AS request_count,
              max(r.received_at) AS last_request_at
         FROM endpoints e
         LEFT JOIN requests r ON r.endpoint_id = e.id
        WHERE e.user_id = $1
        GROUP BY e.id
        ORDER BY e.created_at DESC`,
      [req.user!.id],
    );
    return rows;
  });

  const endpointParamsSchema = {
    params: {
      type: 'object',
      required: ['endpointId'],
      properties: { endpointId: { type: 'string', pattern: UUID_PATTERN } },
    },
  } as const;

  // Request history for one endpoint. Summary only — no bodies — so the
  // list stays cheap even when payloads are large.
  app.get<{
    Params: { endpointId: string };
    Querystring: { limit?: number };
  }>(
    '/:endpointId/requests',
    {
      schema: {
        ...endpointParamsSchema,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req, reply) => {
      const owned = await app.db.query(
        'SELECT 1 FROM endpoints WHERE id = $1 AND user_id = $2',
        [req.params.endpointId, req.user!.id],
      );
      if (owned.rowCount === 0) {
        return reply.code(404).send({ error: 'endpoint not found' });
      }
      const { rows } = await app.db.query(
        `SELECT id, method, path, query, content_type, body_size, ip, received_at
           FROM requests
          WHERE endpoint_id = $1
          ORDER BY received_at DESC
          LIMIT $2`,
        [req.params.endpointId, req.query.limit ?? 50],
      );
      return rows;
    },
  );

  // Full detail for one captured request, including headers and body.
  app.get<{ Params: { endpointId: string; requestId: string } }>(
    '/:endpointId/requests/:requestId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['endpointId', 'requestId'],
          properties: {
            endpointId: { type: 'string', pattern: UUID_PATTERN },
            requestId: { type: 'string', pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (req, reply) => {
      const { rows } = await app.db.query<{
        id: string;
        method: string;
        path: string;
        query: string;
        headers: Record<string, string | string[]>;
        body: Buffer | null;
        body_size: number;
        content_type: string | null;
        ip: string | null;
        received_at: string;
      }>(
        `SELECT r.id, r.method, r.path, r.query, r.headers, r.body,
                r.body_size, r.content_type, r.ip, r.received_at
           FROM requests r
           JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.id = $1 AND e.id = $2 AND e.user_id = $3`,
        [req.params.requestId, req.params.endpointId, req.user!.id],
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'request not found' });
      }

      const row = rows[0]!;
      // Bodies are stored as raw bytes. Return text when it's valid UTF-8,
      // base64 otherwise — the client decides how to display each.
      let body: string | null = null;
      let bodyEncoding: 'utf8' | 'base64' | null = null;
      if (row.body && row.body.length > 0) {
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(row.body);
          bodyEncoding = 'utf8';
        } catch {
          body = row.body.toString('base64');
          bodyEncoding = 'base64';
        }
      }

      return {
        id: row.id,
        method: row.method,
        path: row.path,
        query: row.query,
        headers: row.headers,
        body,
        bodyEncoding,
        bodySize: row.body_size,
        contentType: row.content_type,
        ip: row.ip,
        receivedAt: row.received_at,
      };
    },
  );
};
