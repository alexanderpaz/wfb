import fastifyCookie from '@fastify/cookie';
import type { User } from '@wfb/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import authModule from './auth/index.js';
import type { Config } from './config.js';
import filesModule from './files/index.js';
import { registerHealth } from './health.js';
import opsModule from './jobs/index.js';
import './lib/auth-context.js';
import { createPrisma } from './lib/db.js';
import { registerErrorHandler } from './lib/errors.js';
import { createStore } from './lib/kv.js';
import { loggingOptions } from './lib/logger.js';
import type { ModuleOptions, Services } from './lib/module.js';
import previewModule from './preview/index.js';
import { registerStatic } from './static.js';

export interface BuildOptions {
  config: Config;
  services?: Partial<Services>;
  /**
   * Test-only: authenticate every request as this user and skip the auth
   * module (no sessions/CSRF). Lets feature modules be tested in isolation.
   */
  testUser?: User;
}

export async function buildApp({
  config,
  services: overrides,
  testUser,
}: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...loggingOptions(config),
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  const services: Services = {
    kv: overrides?.kv ?? createStore(config.redisUrl),
    prisma: overrides?.prisma !== undefined ? overrides.prisma : createPrisma(config.databaseUrl),
  };
  app.addHook('onClose', async () => {
    await services.kv.close();
    await services.prisma?.$disconnect();
  });

  registerErrorHandler(app);
  app.decorateRequest('user', null);
  await app.register(fastifyCookie, { secret: config.session.secret });

  registerHealth(app, services);

  const moduleOptions: ModuleOptions = { config, services };
  if (testUser) {
    app.addHook('onRequest', async (request) => {
      request.user = testUser;
    });
  } else {
    await app.register(authModule, moduleOptions);
  }
  await app.register(filesModule, moduleOptions);
  await app.register(previewModule, moduleOptions);
  await app.register(opsModule, moduleOptions);

  await registerStatic(app, config.webDist);
  return app;
}
