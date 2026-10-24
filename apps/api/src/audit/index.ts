import type { User } from '@wfb/contracts';
import fp from 'fastify-plugin';
import { HttpError } from '../lib/errors.js';
import type { ModuleOptions } from '../lib/module.js';
import { AuditService, type AuditAction, type AuditOutcome } from './service.js';

export { AuditService } from './service.js';
export type { AuditAction, AuditEvent, AuditOutcome } from './service.js';

/** One affected entry of a multi-item operation (delete, copy, move, upload, trash). */
export interface AuditItem {
  share: string;
  path: string;
  target?: string | null;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

/**
 * What a route is about to do. Set it on `request.audit` once the input is
 * parsed; it is recorded when the response is sent: a 4xx/5xx becomes one
 * `failure` event (plus any `items` already done), otherwise one event per
 * item, or a single `success` event when there are no items.
 */
export interface AuditIntent {
  action: AuditAction;
  /** Defaults to `request.user` at response time (logout clears it, so it sets this). */
  user?: User | null;
  username?: string;
  share?: string | null;
  path?: string | null;
  target?: string | null;
  detail?: Record<string, unknown>;
  items?: AuditItem[];
  /** The route records the event itself later (e.g. transfers running as jobs). */
  skip?: boolean;
  /** Error code of the failed request, filled in by the module. */
  error?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    audit: AuditService;
  }
  interface FastifyRequest {
    audit: AuditIntent | null;
  }
}

/** `share:/path` form used for audit targets. */
export const refTarget = (ref: { share: string; path: string }) => `${ref.share}:${ref.path}`;

/** Audit log module: `app.audit.record(event)` and the `request.audit` intent. */
export default fp<ModuleOptions>(
  async (app, { services }) => {
    const audit = new AuditService(services.prisma, app.log);
    app.decorate('audit', audit);
    app.decorateRequest('audit', null);
    app.addHook('onClose', async () => audit.flush());

    app.addHook('onError', async (request, _reply, err) => {
      if (request.audit) {
        request.audit.error =
          err instanceof HttpError ? err.code : ((err as { code?: string }).code ?? 'ERROR');
      }
    });

    app.addHook('onResponse', async (request, reply) => {
      const intent = request.audit;
      if (!intent || intent.skip) return;
      const base = {
        action: intent.action,
        user: intent.user !== undefined ? intent.user : request.user,
        username: intent.username,
        ip: request.ip,
      };
      for (const item of intent.items ?? []) {
        void audit.record({ ...base, ...item, detail: { ...intent.detail, ...item.detail } });
      }
      if (reply.statusCode >= 400) {
        void audit.record({
          ...base,
          share: intent.share,
          path: intent.path,
          target: intent.target,
          outcome: 'failure',
          detail: { ...intent.detail, status: reply.statusCode, error: intent.error ?? null },
        });
      } else if (!intent.items) {
        void audit.record({
          ...base,
          share: intent.share,
          path: intent.path,
          target: intent.target,
          outcome: 'success',
          detail: intent.detail,
        });
      }
    });
  },
  { name: 'wfb-audit' },
);
