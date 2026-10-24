import type { FastifyRequest } from 'fastify';
import { HttpError } from '../lib/errors.js';

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Rejects cross-site state-changing requests based on the browser-supplied
 * `Sec-Fetch-Site` and `Origin` headers. Requests without them (curl, older
 * browsers) pass: the CSRF token / JSON-only login still protect them.
 */
export function assertSameOrigin(request: FastifyRequest, appUrl: string): void {
  const site = header(request, 'sec-fetch-site');
  if (site && !ALLOWED_FETCH_SITES.has(site)) {
    throw new HttpError('CSRF', 'Cross-site request rejected');
  }
  const origin = header(request, 'origin');
  if (origin === undefined) return;
  const allowed = new Set([new URL(appUrl).origin, `${request.protocol}://${request.host}`]);
  if (!allowed.has(origin)) throw new HttpError('CSRF', 'Cross-site request rejected');
}

/**
 * Login has no CSRF token yet; requiring a JSON body means a cross-site page
 * can only send it through a CORS preflight, which this API never grants.
 */
export function assertJsonBody(request: FastifyRequest): void {
  const type = header(request, 'content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw Object.assign(new Error('Expected an application/json body'), { statusCode: 415 });
  }
}
