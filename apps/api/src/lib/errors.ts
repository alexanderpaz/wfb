import type { ApiError, ErrorCode } from '@wfb/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  CSRF: 403,
  INTERNAL: 500,
};

export class HttpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  get statusCode(): number {
    return STATUS[this.code];
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError('BAD_REQUEST', msg, details);
export const unauthenticated = (msg = 'Authentication required') => new HttpError('UNAUTHENTICATED', msg);
export const forbidden = (msg = 'Forbidden') => new HttpError('FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new HttpError('NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) => new HttpError('CONFLICT', msg, details);

function body(code: ErrorCode, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Maps filesystem errno codes to API errors so modules can just rethrow. */
export function fromErrno(err: NodeJS.ErrnoException): HttpError | null {
  switch (err.code) {
    case 'ENOENT':
      return notFound('File or folder not found');
    case 'EEXIST':
    case 'ENOTEMPTY':
      return conflict('An entry with that name already exists');
    case 'EACCES':
    case 'EPERM':
      return forbidden('Permission denied by the file system');
    case 'ENOTDIR':
      return badRequest('Not a folder');
    case 'EISDIR':
      return badRequest('Is a folder');
    case 'EINVAL':
      return badRequest('Invalid operation');
    case 'ENAMETOOLONG':
      return badRequest('Name too long');
    default:
      return null;
  }
}

/**
 * Message safe to return to clients: Node file system errors embed absolute
 * server paths ("ENOSPC: no space left on device, write '/srv/...'"), so
 * they are reduced to their errno code.
 */
export function publicErrorMessage(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const e = err as Partial<NodeJS.ErrnoException> | null;
  if (e && typeof e.code === 'string' && (e.syscall !== undefined || e.path !== undefined)) {
    return fromErrno(e as NodeJS.ErrnoException)?.message ?? e.code;
  }
  return (e as Error | null)?.message || 'failed';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError | NodeJS.ErrnoException, request, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(body('BAD_REQUEST', 'Invalid request', err.flatten()));
    }
    const errno = 'code' in err && typeof err.code === 'string' ? fromErrno(err) : null;
    if (errno) {
      return reply.status(errno.statusCode).send(body(errno.code, errno.message));
    }
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.status(500).send(body('INTERNAL', 'Internal server error'));
    }
    const code: ErrorCode =
      status === 413
        ? 'PAYLOAD_TOO_LARGE'
        : status === 429
          ? 'RATE_LIMITED'
          : status === 404
            ? 'NOT_FOUND'
            : 'BAD_REQUEST';
    return reply.status(status).send(body(code, err.message));
  });
}

export function notFoundBody(method: string, url: string): ApiError {
  return body('NOT_FOUND', `Route ${method} ${url} not found`);
}
