import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, registerUser, resetDb } from './helpers.js';

describe('capture loop: create endpoint → ingest → view', () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;
  let endpointId: string;
  let slug: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    ({ cookies } = await registerUser(app));
    const created = await app.inject({
      method: 'POST',
      url: '/api/endpoints',
      cookies,
      payload: { name: 'stripe sandbox' },
    });
    expect(created.statusCode).toBe(201);
    ({ id: endpointId, slug } = created.json());
  });

  it('requires auth to create endpoints', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/endpoints' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for an unknown slug without capturing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/in/nosuchslug123',
      payload: 'x',
    });
    expect(res.statusCode).toBe(404);
  });

  it('captures a JSON POST with subpath and query, faithfully', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: `/in/${slug}/payments/hook?attempt=2&source=stripe`,
      headers: { 'content-type': 'application/json', 'x-custom': 'abc' },
      payload: '{"amount": 42}',
    });
    expect(ingest.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies,
    });
    expect(list.statusCode).toBe(200);
    const [summary] = list.json();
    expect(summary).toMatchObject({
      method: 'POST',
      path: '/payments/hook',
      query: 'attempt=2&source=stripe',
      content_type: 'application/json',
      body_size: 14,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests/${summary.id}`,
      cookies,
    });
    const req = detail.json();
    expect(req.body).toBe('{"amount": 42}');
    expect(req.bodyEncoding).toBe('utf8');
    expect(req.headers['x-custom']).toBe('abc');
  });

  it('captures any method and content-type without parsing', async () => {
    // Malformed JSON with a JSON content-type must be stored, not rejected —
    // the ingest path never parses.
    const malformed = await app.inject({
      method: 'PUT',
      url: `/in/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json at all',
    });
    expect(malformed.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/in/${slug}` });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies,
    });
    const methods = list.json().map((r: { method: string }) => r.method);
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
  });

  it('stores binary bodies safely and returns them as base64', async () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]); // invalid UTF-8
    await app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: binary,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies,
    });
    const [summary] = list.json();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests/${summary.id}`,
      cookies,
    });
    const req = detail.json();
    expect(req.bodyEncoding).toBe('base64');
    expect(Buffer.from(req.body, 'base64')).toEqual(binary);
  });

  it('lists newest first and counts per endpoint', async () => {
    await app.inject({ method: 'GET', url: `/in/${slug}/first` });
    await app.inject({ method: 'GET', url: `/in/${slug}/second` });

    const endpoints = await app.inject({
      method: 'GET',
      url: '/api/endpoints',
      cookies,
    });
    expect(endpoints.json()[0].request_count).toBe(2);

    const list = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies,
    });
    const paths = list.json().map((r: { path: string }) => r.path);
    expect(paths).toEqual(['/second', '/first']);
  });

  it("never exposes another user's endpoint", async () => {
    const other = await registerUser(app, 'other@example.com');
    const res = await app.inject({
      method: 'GET',
      url: `/api/endpoints/${endpointId}/requests`,
      cookies: other.cookies,
    });
    expect(res.statusCode).toBe(404);
  });
});
