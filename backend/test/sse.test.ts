import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InProcessRequestBus } from '../src/events.js';
import { buildTestApp, registerUser, resetDb } from './helpers.js';
import { SseClient } from './sse-client.js';

describe('InProcessRequestBus', () => {
  it('delivers to subscribers of the same endpoint only, until unsubscribed', () => {
    const bus = new InProcessRequestBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const event = (id: string) => ({
      cursor: id,
      request: { id } as never,
    });

    const offA = bus.subscribe('ep-a', (e) => seenA.push(e.cursor));
    bus.subscribe('ep-b', (e) => seenB.push(e.cursor));

    bus.publish('ep-a', event('1'));
    bus.publish('ep-b', event('2'));
    offA();
    bus.publish('ep-a', event('3'));

    expect(seenA).toEqual(['1']);
    expect(seenB).toEqual(['2']);
  });
});

describe('GET /api/endpoints/:id/stream (SSE)', () => {
  let app: FastifyInstance;
  let base: string;
  let cookies: Record<string, string>;
  let cookieHeader: string;
  let endpointId: string;
  let slug: string;

  beforeAll(async () => {
    app = await buildTestApp();
    // SSE needs a real socket — inject() can't consume a never-ending stream.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || !address) throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    ({ cookies } = await registerUser(app));
    cookieHeader = `sid=${cookies['sid']}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/endpoints',
      cookies,
      payload: {},
    });
    ({ id: endpointId, slug } = created.json());
  });

  it('rejects unauthenticated stream requests', async () => {
    const client = new SseClient(
      `${base}/api/endpoints/${endpointId}/stream`,
      {},
    );
    expect(await client.status()).toBe(401);
    client.close();
  });

  it("404s for another user's endpoint", async () => {
    const other = await registerUser(app, 'other@example.com');
    const client = new SseClient(
      `${base}/api/endpoints/${endpointId}/stream`,
      { cookie: `sid=${other.cookies['sid']}` },
    );
    expect(await client.status()).toBe(404);
    client.close();
  });

  it('streams a capture to a connected client in real time', async () => {
    const client = new SseClient(
      `${base}/api/endpoints/${endpointId}/stream`,
      { cookie: cookieHeader },
    );
    expect(await client.status()).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/in/${slug}/live?a=1`,
      headers: { 'content-type': 'application/json' },
      payload: '{"n":1}',
    });

    const event = await client.next();
    expect(event.event).toBe('request');
    expect(event.id).toBeTruthy();
    const data = JSON.parse(event.data!);
    expect(data).toMatchObject({
      method: 'POST',
      path: '/live',
      query: 'a=1',
      body_size: 7,
    });
    client.close();
  });

  it('replays missed events on reconnect via Last-Event-ID', async () => {
    // Connect, receive one event, remember its id, disconnect.
    const first = new SseClient(`${base}/api/endpoints/${endpointId}/stream`, {
      cookie: cookieHeader,
    });
    await first.status();
    await app.inject({ method: 'GET', url: `/in/${slug}/seen` });
    const seen = await first.next();
    first.close();

    // These land while nobody is connected.
    await app.inject({ method: 'GET', url: `/in/${slug}/missed-1` });
    await app.inject({ method: 'GET', url: `/in/${slug}/missed-2` });

    // Reconnect the way EventSource does: Last-Event-ID header.
    const second = new SseClient(`${base}/api/endpoints/${endpointId}/stream`, {
      cookie: cookieHeader,
      'last-event-id': seen.id!,
    });
    expect(await second.status()).toBe(200);

    const replayed1 = JSON.parse((await second.next()).data!);
    const replayed2 = JSON.parse((await second.next()).data!);
    expect(replayed1.path).toBe('/missed-1');
    expect(replayed2.path).toBe('/missed-2');

    // ...and the stream is live again afterwards.
    await app.inject({ method: 'GET', url: `/in/${slug}/live-again` });
    const live = JSON.parse((await second.next()).data!);
    expect(live.path).toBe('/live-again');
    second.close();
  });

  it('survives a garbage Last-Event-ID (skips catch-up, stays live)', async () => {
    const client = new SseClient(`${base}/api/endpoints/${endpointId}/stream`, {
      cookie: cookieHeader,
      'last-event-id': 'not-a-timestamp',
    });
    expect(await client.status()).toBe(200);

    await app.inject({ method: 'GET', url: `/in/${slug}/still-works` });
    const event = JSON.parse((await client.next()).data!);
    expect(event.path).toBe('/still-works');
    client.close();
  });
});
