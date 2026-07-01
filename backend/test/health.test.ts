import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
