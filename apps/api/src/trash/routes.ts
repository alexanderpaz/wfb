import { API_PREFIX, TrashActionRequest, type OkResponse, type TrashListResponse } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditIntent } from '../audit/index.js';
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
    const audit: AuditIntent = { action: 'trash.restore', share: body.share, detail: { ids: body.ids } };
    request.audit = audit;
    const restored = await trash.restore(user, body.share, body.ids);
    audit.items = restored.map((r) => ({
      share: body.share,
      path: r.path,
      outcome: 'success',
      detail: { id: r.id },
    }));
    return { ok: true };
  });

  app.post(p('/trash/purge'), async (request): Promise<OkResponse> => {
    const user = requireUser(request);
    const body = parse(TrashActionRequest, request.body);
    const audit: AuditIntent = { action: 'trash.purge', share: body.share, detail: { ids: body.ids } };
    request.audit = audit;
    const purged = await trash.purge(user, body.share, body.ids);
    audit.items = purged.flatMap((r) =>
      r.path === null ? [] : [{ share: body.share, path: r.path, outcome: 'success', detail: { id: r.id } }],
    );
    return { ok: true };
  });
}
