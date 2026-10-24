import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { API_PREFIX } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { notFoundBody } from './lib/errors.js';

/**
 * Serves the built React app (when WEB_DIST is set) and installs the single
 * not-found handler: API routes get an ApiError, other GETs get index.html so
 * client-side routes work.
 */
export async function registerStatic(app: FastifyInstance, webDist: string | undefined): Promise<void> {
  let spa = false;
  if (webDist) {
    const root = resolve(webDist);
    if (existsSync(resolve(root, 'index.html'))) {
      await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'] });
      spa = true;
    } else {
      app.log.warn({ root }, 'WEB_DIST has no index.html, static UI disabled');
    }
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith(API_PREFIX) || request.url.startsWith('/healthz');
    if (spa && request.method === 'GET' && !isApi) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send(notFoundBody(request.method, request.url));
  });
}
