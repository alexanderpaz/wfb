import {
  API_PREFIX,
  CreateUploadRequest,
  type EntryResponse,
  type OkResponse,
  type UploadSession,
} from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { requireUser } from '../lib/auth-context.js';
import { parse } from '../lib/validate.js';
import type { UploadService } from './service.js';

const p = (route: string) => `${API_PREFIX}${route}`;

const ChunkQuery = z.object({ offset: z.coerce.number().int().nonnegative() });

/** Must be registered in an encapsulated scope: it adds a raw `application/octet-stream` parser. */
export function registerUploadRoutes(app: FastifyInstance, uploads: UploadService): void {
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.post(p('/uploads'), async (request, reply): Promise<UploadSession> => {
    const user = requireUser(request);
    const session = await uploads.create(user, parse(CreateUploadRequest, request.body));
    reply.status(201);
    return session;
  });

  app.get<{ Params: { id: string } }>(p('/uploads/:id'), async (request): Promise<UploadSession> => {
    const user = requireUser(request);
    return uploads.get(user, request.params.id);
  });

  app.put<{ Params: { id: string } }>(p('/uploads/:id'), async (request): Promise<UploadSession> => {
    const user = requireUser(request);
    const { offset } = parse(ChunkQuery, request.query);
    const body = request.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== 'function') {
      throw Object.assign(new Error('Expected an application/octet-stream body'), { statusCode: 415 });
    }
    const declared = Number(request.headers['content-length']);
    return uploads.append(
      user,
      request.params.id,
      offset,
      body,
      Number.isFinite(declared) ? declared : undefined,
    );
  });

  app.post<{ Params: { id: string } }>(
    p('/uploads/:id/complete'),
    async (request): Promise<EntryResponse> => {
      const user = requireUser(request);
      return { entry: await uploads.complete(user, request.params.id) };
    },
  );

  app.delete<{ Params: { id: string } }>(p('/uploads/:id'), async (request): Promise<OkResponse> => {
    const user = requireUser(request);
    await uploads.abort(user, request.params.id);
    return { ok: true };
  });
}
