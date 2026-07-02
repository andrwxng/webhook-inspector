import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, registerUser, resetDb } from './helpers.js';
import { SseClient } from './sse-client.js';

/**
 * THE horizontal-scaling test: two separate app instances (separate
 * event emitters, separate SSE layers) share only Postgres and Redis.
 * A webhook ingested by instance A must reach a dashboard connected to
 * instance B — which only works if the bus goes through Redis.
 */
describe('RedisRequestBus across instances', () => {
  let instanceA: FastifyInstance; // receives the webhook
  let instanceB: FastifyInstance; // serves the dashboard's SSE stream
  let baseB: string;

  beforeAll(async () => {
    instanceA = await buildTestApp();
    instanceB = await buildTestApp();
    await instanceB.listen({ port: 0, host: '127.0.0.1' });
    const address = instanceB.server.address();
    if (typeof address === 'string' || !address) throw new Error('no port');
    baseB = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await instanceA.close();
    await instanceB.close();
  });
  beforeEach(async () => {
    await resetDb(instanceA); // shared database
  });

  it('delivers a capture from instance A to an SSE client on instance B', async () => {
    const { cookies } = await registerUser(instanceA);
    const created = await instanceA.inject({
      method: 'POST',
      url: '/api/endpoints',
      cookies,
      payload: {},
    });
    const { id: endpointId, slug } = created.json();

    // Dashboard connects to instance B (session works there too — shared DB).
    const client = new SseClient(
      `${baseB}/api/endpoints/${endpointId}/stream`,
      { cookie: `sid=${cookies['sid']}` },
    );
    expect(await client.status()).toBe(200);

    // Webhook lands on instance A.
    await instanceA.inject({
      method: 'POST',
      url: `/in/${slug}/cross-instance`,
      headers: { 'content-type': 'application/json' },
      payload: '{"via":"redis"}',
    });

    const event = await client.next();
    expect(event.event).toBe('request');
    const data = JSON.parse(event.data!);
    expect(data.path).toBe('/cross-instance');
    client.close();
  });
});
