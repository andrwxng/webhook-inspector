import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isPrivateIp } from '../src/lib/ssrf.js';
import { buildTestApp, registerUser, resetDb } from './helpers.js';
import { startTarget, type TargetServer } from './target-server.js';

describe('isPrivateIp', () => {
  it.each([
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // just outside 172.16/12
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true], // CGNAT
    ['0.0.0.0', true],
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true], // IPv4-mapped private
    ['::ffff:8.8.8.8', false], // IPv4-mapped public
    ['2606:4700::1111', false],
    ['not-an-ip', true], // unparseable → refuse
  ])('%s → private=%s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

async function capture(
  app: FastifyInstance,
): Promise<{
  cookies: Record<string, string>;
  endpointId: string;
  slug: string;
  requestId: string;
}> {
  const { cookies } = await registerUser(app);
  const created = await app.inject({
    method: 'POST',
    url: '/api/endpoints',
    cookies,
    payload: {},
  });
  const { id: endpointId, slug } = created.json();
  await app.inject({
    method: 'POST',
    url: `/in/${slug}/orders/hook?attempt=1`,
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': 'sig-abc123',
      connection: 'keep-alive',
    },
    payload: '{"amount":42}',
  });
  const list = await app.inject({
    method: 'GET',
    url: `/api/endpoints/${endpointId}/requests`,
    cookies,
  });
  return { cookies, endpointId, slug, requestId: list.json()[0].id };
}

describe('replay (faithful reconstruction)', () => {
  let app: FastifyInstance;
  let target: TargetServer;

  beforeAll(async () => {
    // Private targets allowed here: the whole point is replaying to a
    // local target server and inspecting what it received.
    app = await buildTestApp({ replayAllowPrivate: true });
    target = await startTarget();
  });
  afterAll(async () => {
    await app.close();
    await target.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    target.seen.length = 0;
    target.setResponse(200, 'target-ok');
  });

  it('replays method, headers, and body faithfully — minus hop-by-hop and host', async () => {
    const { cookies, endpointId, requestId } = await capture(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/endpoints/${endpointId}/requests/${requestId}/replay`,
      cookies,
      payload: { targetUrl: `${target.url}/receive` },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.status).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.body).toEqual({ encoding: 'utf8', data: 'target-ok' });

    const received = await target.waitForRequest();
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/receive'); // exact target URL, as given
    expect(received.body.toString()).toBe('{"amount":42}');
    // signature and content-type survive byte-for-byte
    expect(received.headers['x-webhook-signature']).toBe('sig-abc123');
    expect(received.headers['content-type']).toBe('application/json');
    // host is the TARGET's, not ours
    expect(received.headers.host).toBe(`127.0.0.1:${target.port}`);
    // content-length recomputed correctly
    expect(received.headers['content-length']).toBe('13');
  });

  it('replays binary bodies byte-for-byte', async () => {
    const { cookies } = await registerUser(app, 'bin@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/endpoints',
      cookies,
      payload: {},
    });
    const { id: endpointId, slug } = created.json();
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xfe]);
    await app.inject({
      method: 'PUT',
      url: `/in/${slug}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: binary,
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies,
    });

    await app.inject({
      method: 'POST',
      url: `/api/endpoints/${endpointId}/requests/${list.json()[0].id}/replay`,
      cookies,
      payload: { targetUrl: target.url },
    });
    const received = await target.waitForRequest();
    expect(received.method).toBe('PUT');
    expect(received.body).toEqual(binary);
  });

  it('edit-and-resend: overrides win, engine still applies', async () => {
    const { cookies, endpointId, requestId } = await capture(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/endpoints/${endpointId}/requests/${requestId}/replay`,
      cookies,
      payload: {
        targetUrl: `${target.url}/edited`,
        method: 'put',
        headers: { 'x-edited': 'yes', host: 'spoofed.example' },
        body: { encoding: 'utf8', data: 'EDITED BODY' },
      },
    });
    expect(res.statusCode).toBe(200);

    const received = await target.waitForRequest();
    expect(received.method).toBe('PUT'); // uppercased
    expect(received.body.toString()).toBe('EDITED BODY');
    expect(received.headers['x-edited']).toBe('yes');
    // provided headers REPLACE the captured set
    expect(received.headers['x-webhook-signature']).toBeUndefined();
    // ...but the engine still strips protected headers, even edited ones
    expect(received.headers.host).toBe(`127.0.0.1:${target.port}`);
    expect(received.headers['content-length']).toBe('11');
  });

  it('reports non-2xx target responses instead of failing', async () => {
    const { cookies, endpointId, requestId } = await capture(app);
    target.setResponse(503, 'nope');

    const res = await app.inject({
      method: 'POST',
      url: `/api/endpoints/${endpointId}/requests/${requestId}/replay`,
      cookies,
      payload: { targetUrl: target.url },
    });
    expect(res.statusCode).toBe(200); // the replay itself succeeded
    expect(res.json().status).toBe(503);
  });

  it('502s when the target is unreachable', async () => {
    const { cookies, endpointId, requestId } = await capture(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/endpoints/${endpointId}/requests/${requestId}/replay`,
      cookies,
      payload: { targetUrl: 'http://127.0.0.1:1/' }, // nothing listens
    });
    expect(res.statusCode).toBe(502);
  });
});

describe('SSRF guard (replayAllowPrivate off — the default)', () => {
  let app: FastifyInstance;
  let ctx: Awaited<ReturnType<typeof capture>>;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb(app);
    ctx = await capture(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['loopback IP', 'http://127.0.0.1:3000/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private range', 'http://10.0.0.5/admin'],
    ['IPv6 loopback', 'http://[::1]:8080/'],
    ['localhost via DNS', 'http://localhost:3000/'],
    ['non-http protocol', 'file:///etc/passwd'],
  ])('blocks %s with 400', async (_label, targetUrl) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/endpoints/${ctx.endpointId}/requests/${ctx.requestId}/replay`,
      cookies: ctx.cookies,
      payload: { targetUrl },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('blocked');
  });

  it('rejects private forward_url at save time', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/endpoints/${ctx.endpointId}`,
      cookies: ctx.cookies,
      payload: { forward_url: 'http://169.254.169.254/hook' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('auto-forwarding', () => {
  let app: FastifyInstance;
  let target: TargetServer;

  beforeAll(async () => {
    app = await buildTestApp({ replayAllowPrivate: true });
    target = await startTarget();
  });
  afterAll(async () => {
    await app.close();
    await target.close();
  });
  beforeEach(async () => {
    await resetDb(app);
    target.seen.length = 0;
    target.setResponse(200, 'ok');
  });

  it('forwards captures to the configured target with path and query appended', async () => {
    const { cookies, endpointId, slug } = await capture(app);
    await app.inject({
      method: 'PATCH',
      url: `/api/endpoints/${endpointId}`,
      cookies,
      payload: { forward_url: `${target.url}/hook/` },
    });
    target.seen.length = 0; // ignore anything before forwarding was on

    await app.inject({
      method: 'POST',
      url: `/in/${slug}/payments?retry=2`,
      headers: { 'content-type': 'text/plain' },
      payload: 'forward me',
    });

    const received = await target.waitForRequest();
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/hook/payments?retry=2');
    expect(received.body.toString()).toBe('forward me');
  });

  it('capture succeeds even when the forward target is down or failing', async () => {
    const { cookies, endpointId, slug } = await capture(app);
    await app.inject({
      method: 'PATCH',
      url: `/api/endpoints/${endpointId}`,
      cookies,
      payload: { forward_url: 'http://127.0.0.1:1/dead' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      payload: 'still captured',
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies,
    });
    expect(list.json().length).toBe(2); // the capture() one + this one
  });

  it('clearing forward_url stops forwarding', async () => {
    const { cookies, endpointId, slug } = await capture(app);
    await app.inject({
      method: 'PATCH',
      url: `/api/endpoints/${endpointId}`,
      cookies,
      payload: { forward_url: target.url },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/endpoints/${endpointId}`,
      cookies,
      payload: { forward_url: null },
    });
    target.seen.length = 0;

    await app.inject({ method: 'GET', url: `/in/${slug}/quiet` });
    await new Promise((r) => setTimeout(r, 300));
    expect(target.seen.length).toBe(0);
  });
});
