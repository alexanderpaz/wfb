import { z } from 'zod';

export const API_PREFIX = '/api';
export const SESSION_COOKIE = 'wfb_sid';
export const CSRF_COOKIE = 'wfb_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const ErrorCode = z.enum([
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CSRF',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Boolean query-string flag: "true"/"1"/"" are true, "false"/"0" false. */
export const QueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === '');

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.record(z.enum(['ok', 'fail', 'skipped'])),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
