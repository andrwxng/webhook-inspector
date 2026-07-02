import type { FastifyPluginAsync } from 'fastify';
import { findSsrfError } from '../../lib/ssrf.js';

const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

interface ReplayBody {
  targetUrl: string;
  method?: string;
  /** If provided, REPLACES the captured header set entirely. */
  headers?: Record<string, string>;
  /** If present, replaces the body (null = send no body). Absent = original. */
  body?: { encoding: 'utf8' | 'base64'; data: string } | null;
}

/**
 * POST /api/endpoints/:endpointId/requests/:requestId/replay
 *
 * Plain replay and edit-and-resend are the same operation: the captured
 * request is the baseline, any override in the body wins, and the same
 * faithful-reconstruction engine (lib/replay.ts) sends the result.
 * Registered inside the endpoints plugin, so requireAuth already ran.
 */
export const replayRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: { endpointId: string; requestId: string };
    Body: ReplayBody;
  }>(
    '/:endpointId/requests/:requestId/replay',
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
        body: {
          type: 'object',
          required: ['targetUrl'],
          additionalProperties: false,
          properties: {
            targetUrl: { type: 'string', minLength: 1, maxLength: 2000 },
            method: {
              type: 'string',
              minLength: 1,
              maxLength: 16,
              pattern: '^[A-Za-z]+$',
            },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string', maxLength: 8192 },
              maxProperties: 100,
            },
            body: {
              type: ['object', 'null'],
              required: ['encoding', 'data'],
              additionalProperties: false,
              properties: {
                encoding: { enum: ['utf8', 'base64'] },
                data: { type: 'string', maxLength: 2 * 1024 * 1024 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { rows } = await app.db.query<{
        method: string;
        headers: Record<string, string | string[]>;
        body: Buffer | null;
      }>(
        `SELECT r.method, r.headers, r.body
           FROM requests r
           JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.id = $1 AND e.id = $2 AND e.user_id = $3`,
        [req.params.requestId, req.params.endpointId, req.user!.id],
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'request not found' });
      }
      const captured = rows[0]!;

      const method = req.body.method?.toUpperCase() ?? captured.method;
      const headers = req.body.headers ?? captured.headers;
      let body: Buffer | null;
      if ('body' in req.body) {
        body =
          req.body.body === null
            ? null
            : Buffer.from(req.body.body.data, req.body.body.encoding);
      } else {
        body = captured.body;
      }

      try {
        const result = await app.replayer.send({
          url: req.body.targetUrl,
          method,
          headers,
          body,
        });
        return result;
      } catch (err) {
        const ssrf = findSsrfError(err);
        if (ssrf) {
          return reply
            .code(400)
            .send({ error: `target blocked: ${ssrf.message}` });
        }
        req.log.warn({ err }, 'replay failed');
        return reply
          .code(502)
          .send({ error: 'replay failed: could not reach target' });
      }
    },
  );
};
