import type { FastifyPluginAsync } from 'fastify';
import type { RequestEvent, RequestSummary } from '../../events.js';

const HEARTBEAT_MS = 25_000;

const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * GET /api/endpoints/:endpointId/stream — Server-Sent Events.
 *
 * Live delivery: ingest publishes on the in-process bus; every open
 * stream for that endpoint writes the event to its socket.
 *
 * Missed events: each event carries `id: <received_at as pg text>`.
 * EventSource echoes it back as Last-Event-ID on reconnect, and we replay
 * everything newer from Postgres before going live. To close the gap
 * between "catch-up query ran" and "subscription active", we subscribe
 * FIRST, buffer live events during catch-up, then flush the buffer minus
 * anything the catch-up already sent (dedupe by request id).
 *
 * Registered inside the endpoints plugin, so requireAuth already ran.
 */
export const streamRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { endpointId: string } }>(
    '/:endpointId/stream',
    {
      schema: {
        params: {
          type: 'object',
          required: ['endpointId'],
          properties: {
            endpointId: { type: 'string', pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (req, reply) => {
      const { endpointId } = req.params;
      const owned = await app.db.query(
        'SELECT 1 FROM endpoints WHERE id = $1 AND user_id = $2',
        [endpointId, req.user!.id],
      );
      if (owned.rowCount === 0) {
        return reply.code(404).send({ error: 'endpoint not found' });
      }

      // From here on we own the raw socket; Fastify's reply lifecycle ends.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // tell buffering proxies to stream
      });
      raw.write('retry: 2000\n\n');

      const send = (cursor: string, request: RequestSummary) => {
        raw.write(
          `id: ${cursor}\nevent: request\ndata: ${JSON.stringify(request)}\n\n`,
        );
      };

      // 1. Subscribe first — events during catch-up land in the buffer.
      let catchingUp = true;
      const buffered: RequestEvent[] = [];
      const unsubscribe = app.bus.subscribe(endpointId, (event) => {
        if (catchingUp) buffered.push(event);
        else send(event.cursor, event.request);
      });

      const heartbeat = setInterval(() => {
        raw.write(': heartbeat\n\n');
      }, HEARTBEAT_MS);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        raw.end();
      });

      // 2. Replay what the client missed while disconnected.
      const sent = new Set<string>();
      const lastEventId = req.headers['last-event-id'];
      if (typeof lastEventId === 'string' && lastEventId.length > 0) {
        try {
          const missed = await app.db.query<
            RequestSummary & { cursor: string }
          >(
            `SELECT id, method, path, query, content_type, body_size, ip,
                    received_at, received_at::text AS cursor
               FROM requests
              WHERE endpoint_id = $1 AND received_at > $2::timestamptz
              ORDER BY received_at ASC
              LIMIT 500`,
            [endpointId, lastEventId],
          );
          for (const { cursor, ...request } of missed.rows) {
            sent.add(request.id);
            send(cursor, request);
          }
        } catch (err) {
          // Unparseable cursor (client sent garbage) — skip catch-up rather
          // than kill the stream; the client still has live delivery.
          req.log.warn({ err, lastEventId }, 'SSE catch-up failed');
        }
      }

      // 3. Flush events that arrived mid-catch-up, minus duplicates.
      for (const event of buffered) {
        if (!sent.has(event.request.id)) send(event.cursor, event.request);
      }
      catchingUp = false;
    },
  );
};
