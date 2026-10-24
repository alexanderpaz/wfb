import { API_PREFIX, type Job, type JobResponse, type JobsResponse } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { requireUser } from '../lib/auth-context.js';
import { isTerminal, type JobManager } from './manager.js';

export interface JobRoutesOptions {
  /** Minimum interval between progress events of one stream. */
  throttleMs?: number;
  heartbeatMs?: number;
}

const p = (route: string) => `${API_PREFIX}${route}`;

export function registerJobRoutes(app: FastifyInstance, jobs: JobManager, opts: JobRoutesOptions = {}): void {
  const throttleMs = opts.throttleMs ?? 250;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  app.get(p('/jobs'), async (request): Promise<JobsResponse> => {
    const user = requireUser(request);
    return { jobs: jobs.list(user.id) };
  });

  app.get<{ Params: { id: string } }>(p('/jobs/:id'), async (request): Promise<JobResponse> => {
    const user = requireUser(request);
    return { job: jobs.get(user.id, request.params.id) };
  });

  app.post<{ Params: { id: string } }>(p('/jobs/:id/cancel'), async (request): Promise<JobResponse> => {
    const user = requireUser(request);
    return { job: await jobs.cancel(user.id, request.params.id) };
  });

  /**
   * Server-sent events: the current state right away, then throttled updates
   * (the final state is always sent) and a heartbeat comment; the stream ends
   * when the job finishes.
   */
  app.get<{ Params: { id: string } }>(p('/jobs/:id/events'), async (request, reply) => {
    const user = requireUser(request);
    const initial = jobs.get(user.id, request.params.id);
    const stream = new PassThrough();
    const send = (job: Job) => stream.write(`data: ${JSON.stringify(job)}\n\n`);

    let lastSent = 0;
    let pending: Job | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let unsubscribe = () => {};
    let heartbeat: NodeJS.Timeout | null = null;

    const close = () => {
      unsubscribe();
      if (flushTimer) clearTimeout(flushTimer);
      if (heartbeat) clearInterval(heartbeat);
      flushTimer = heartbeat = null;
      if (!stream.writableEnded) stream.end();
    };
    const flush = () => {
      flushTimer = null;
      if (!pending) return;
      const job = pending;
      pending = null;
      lastSent = Date.now();
      send(job);
      if (isTerminal(job)) close();
    };

    send(initial);
    lastSent = Date.now();
    if (isTerminal(initial)) {
      stream.end();
    } else {
      unsubscribe = jobs.subscribe(user.id, initial.id, (job) => {
        pending = job;
        const wait = throttleMs - (Date.now() - lastSent);
        if (isTerminal(job) || wait <= 0) {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, wait);
        }
      });
      heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), heartbeatMs);
      // The job may have finished between get() and subscribe().
      const now = jobs.get(user.id, initial.id);
      if (isTerminal(now)) {
        pending = now;
        flush();
      }
    }
    // Fires when the response finishes or the client disconnects.
    reply.raw.on('close', close);

    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
}
