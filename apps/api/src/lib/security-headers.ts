import { API_PREFIX } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';

/** The built SPA: only same-origin scripts; previews are embedded in same-origin iframes. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** JSON and other non-document responses must never render nor be framed. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * User files and previews: passive content even if opened directly (no
 * scripts, plugins nor navigation). Same-origin framing is allowed for the
 * preview pane.
 */
export const FILE_CSP =
  "default-src 'none'; img-src 'self' data: blob:; media-src 'self'; style-src 'unsafe-inline'; " +
  "frame-ancestors 'self'; sandbox";
/** Chromium refuses to render PDFs in sandboxed documents, so PDFs keep the CSP without `sandbox`. */
export const PDF_CSP = FILE_CSP.replace(/; sandbox$/, '');

export const fileCspFor = (mime: string) => (mime.startsWith('application/pdf') ? PDF_CSP : FILE_CSP);

const isApiUrl = (url: string) =>
  url === API_PREFIX ||
  url.startsWith(`${API_PREFIX}/`) ||
  url.startsWith(`${API_PREFIX}?`) ||
  url.startsWith('/healthz');

/**
 * Baseline headers on every response. Routes that serve user content set
 * their own `Content-Security-Policy` / `X-Frame-Options` before sending.
 */
export function registerSecurityHeaders(app: FastifyInstance, opts: { hsts: boolean }): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!reply.hasHeader('Content-Security-Policy')) {
      // Chosen by URL, not Content-Type: a 304 for index.html has no type, and
      // browsers apply its headers to the cached page.
      reply.header('Content-Security-Policy', isApiUrl(request.url) ? API_CSP : APP_CSP);
    }
    if (!reply.hasHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'DENY');
    if (opts.hsts) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
}
