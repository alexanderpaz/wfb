import { HealthResponse } from '@wfb/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from './helpers.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('health', () => {
  it('responds ok on /healthz', async () => {
    app = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = HealthResponse.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('skipped');
  });

  it('returns ApiError for unknown API routes', async () => {
    app = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
