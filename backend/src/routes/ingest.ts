import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

/**
 * INGEST PATH — untrusted traffic from the outside world.
 *
 * Registered under /in. Design rules that differ from the viewer API:
 *  - No auth, no cookies, no JSON parsing. The body is captured as raw
 *    bytes for EVERY content type and never interpreted.
 *  - Content-type parsers are encapsulated per Fastify plugin scope, so
 *    replacing them here does not affect /api (which keeps JSON parsing).
 *  - Respond fast and small; webhook senders only care about the status.
 */
export const ingestRoutes: FastifyPluginAsync = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  type IngestParams = { slug: string; '*'?: string };

  async function capture(
    req: FastifyRequest<{ Params: IngestParams }>,
    reply: FastifyReply,
  ) {
    const { slug } = req.params;

    const endpoint = await app.db.query<{ id: string }>(
      'SELECT id FROM endpoints WHERE slug = $1',
      [slug],
    );
    if (endpoint.rowCount === 0) {
      return reply.code(404).send({ error: 'unknown endpoint' });
    }

    const endpointId = endpoint.rows[0]!.id;
    const subPath = '/' + (req.params['*'] ?? '');
    const queryIndex = req.raw.url?.indexOf('?') ?? -1;
    const query =
      queryIndex >= 0 ? (req.raw.url?.slice(queryIndex + 1) ?? '') : '';
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    const contentType = req.headers['content-type'] ?? null;

    const inserted = await app.db.query<{
      id: string;
      received_at: string;
      cursor: string;
    }>(
      `INSERT INTO requests
         (endpoint_id, method, path, query, headers, body, body_size, content_type, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, received_at, received_at::text AS cursor`,
      [
        endpointId,
        req.method,
        subPath,
        query,
        JSON.stringify(req.headers),
        body,
        body?.length ?? 0,
        contentType,
        req.ip,
      ],
    );

    // Tell any dashboards watching this endpoint, AFTER the row is durable —
    // the stream must never announce a request that a reload can't find.
    const row = inserted.rows[0]!;
    app.bus.publish(endpointId, {
      cursor: row.cursor,
      request: {
        id: row.id,
        method: req.method,
        path: subPath,
        query,
        content_type: contentType,
        body_size: body?.length ?? 0,
        ip: req.ip,
        received_at: row.received_at,
      },
    });

    return reply.code(200).send({ captured: true });
  }

  app.all('/:slug', capture);
  app.all('/:slug/*', capture);
};
