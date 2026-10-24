import type { User } from '@wfb/contracts';
import type { FastifyRequest } from 'fastify';
import { unauthenticated } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth module (or by tests) when the request carries a valid session. */
    user: User | null;
  }
}

/** Returns the authenticated user or throws 401. Use in every protected route. */
export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw unauthenticated();
  return request.user;
}
