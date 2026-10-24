import { API_PREFIX, TrashActionRequest, type OkResponse, type TrashListResponse } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../lib/auth-context.js';
import { parse } from '../lib/validate.js';
import type { TrashService } from './service.js';

const p = (route: string) => `${API_PREFIX}${route}`;

const TrashListQuery = z.object({ share: z.string().min(1) });

export function registerTrashRoutes(app: FastifyInstance, trash: TrashService): void {
  app.get(p('/trash'), async (request): Promise<TrashListResponse> => {
    const user = requireUser(request);
    const { share } = parse(TrashListQuery, request.query);
    return { items: await trash.list(user, share) };
  });

  app.post(p('/trash/restore'), async (request): Promise<OkResponse> => {
    const user = requireUser(request);
    const body = parse(TrashActionRequest, request.body);
    await trash.restore(user, body.share, body.ids);
    return { ok: true };
  });

  app.post(p('/trash/purge'), async (request): Promise<OkResponse> => {
    const user = requireUser(request);
    const body = parse(TrashActionRequest, request.body);
    await trash.purge(user, body.share, body.ids);
    return { ok: true };
  });
}
