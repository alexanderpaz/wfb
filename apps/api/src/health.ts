import type { HealthResponse } from '@wfb/contracts';
import { API_PREFIX } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Services } from './lib/module.js';

export const VERSION = process.env.APP_VERSION ?? '0.1.0';

export function registerHealth(app: FastifyInstance, services: Services): void {
  const handler = async (): Promise<HealthResponse> => {
    const checks: HealthResponse['checks'] = {};
    checks.kv = (await services.kv.ping()) ? 'ok' : 'fail';
    if (services.prisma) {
      try {
        await services.prisma.$queryRaw`SELECT 1`;
        checks.db = 'ok';
      } catch {
        checks.db = 'fail';
      }
    } else {
      checks.db = 'skipped';
    }
    const status = Object.values(checks).includes('fail') ? 'degraded' : 'ok';
    return { status, version: VERSION, checks };
  };

  app.get('/healthz', async (_req, reply) => {
    const result = await handler();
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });
  app.get(`${API_PREFIX}/healthz`, handler);
}
