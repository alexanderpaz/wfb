import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_CSP, APP_CSP, FILE_CSP, PDF_CSP } from '../../src/lib/security-headers.js';
import { createFixture, users, type Fixture } from '../files/fixture.js';

let fx: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fx = await createFixture();
  const webDist = path.join(fx.tmp, 'web');
  await mkdir(webDist, { recursive: true });
  await writeFile(path.join(webDist, 'index.html'), '<!doctype html><title>wfb</title>');
  app = await fx.app(users.alice, { WEB_DIST: webDist });
});
afterEach(async () => fx.cleanup());

function expectBaseline(headers: Record<string, unknown>) {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
}

describe('security headers', () => {
  it('protects the SPA with a strict CSP and anti-framing', async () => {
    for (const url of ['/', '/shares/public/deep/link']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expectBaseline(res.headers);
      expect(res.headers['content-security-policy']).toBe(APP_CSP);
      expect(APP_CSP).toContain("frame-ancestors 'none'");
      expect(APP_CSP).toContain("script-src 'self'");
      expect(APP_CSP).not.toContain('unsafe-eval');
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('keeps the app CSP on 304 revalidations of index.html', async () => {
    const first = await app.inject({ method: 'GET', url: '/' });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const revalidated = await app.inject({ method: 'GET', url: '/', headers: { 'if-none-match': etag } });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers['content-security-policy']).toBe(APP_CSP);
  });

  it('sets a no-render CSP on API and error responses', async () => {
    for (const url of ['/api/shares', '/api/nope', '/healthz', '/api/files?share=nope&path=/']) {
      const res = await app.inject({ method: 'GET', url });
      expectBaseline(res.headers);
      expect(res.headers['content-security-policy']).toBe(API_CSP);
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('never renders active content from downloads and sandboxes them', async () => {
    await fx.file('public/x.html', '<script>alert(1)</script>');
    await fx.file('public/x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const name of ['x.html', 'x.svg']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/files/download?share=public&path=/${name}&inline=true`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['content-security-policy']).toBe(FILE_CSP);
      expect(FILE_CSP).toMatch(/; sandbox$/);
      expectBaseline(res.headers);
    }
  });

  it('allows same-origin framing only for previews', async () => {
    await fx.file('public/a.txt', 'hi');
    await fx.file('public/a.pdf', '%PDF-1.4\n');
    const text = await app.inject({ method: 'GET', url: '/api/preview/content?share=public&path=/a.txt' });
    expect(text.headers['content-security-policy']).toBe(FILE_CSP);
    expect(text.headers['x-frame-options']).toBe('SAMEORIGIN');
    expectBaseline(text.headers);
    const pdf = await app.inject({ method: 'GET', url: '/api/preview/content?share=public&path=/a.pdf' });
    expect(pdf.headers['content-security-policy']).toBe(PDF_CSP);
    expect(PDF_CSP).toContain("frame-ancestors 'self'");
    expect(PDF_CSP).toContain("default-src 'none'");
  });

  it('sends HSTS only for https deployments', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/' })).headers['strict-transport-security'],
    ).toBeUndefined();
    const https = await fx.app(users.alice, { APP_URL: 'https://files.example.org' });
    const res = await https.inject({ method: 'GET', url: '/api/shares' });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });
});
