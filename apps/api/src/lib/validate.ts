import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors.js';

/** Parses request input with a contract schema and throws a 400 ApiError on failure. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('Invalid request', result.error.flatten());
  }
  return result.data;
}
