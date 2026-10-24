import { Job, JobResponse, JobsResponse, TransferResponse } from '@wfb/contracts';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager } from '../../src/jobs/manager.js';
import { createFixture, users, type Fixture } from '../files/fixture.js';

let fx: Fixture;
let app: FastifyInstance;

const MB = 1024 * 1024;
const HOME =
  'home:\n  enabled: true\n  root: HOMES\n  name: Mi carpeta\n  permissions: [read, write, delete]\n';

beforeEach(async () => {
  fx = await createFixture({ yamlExtra: HOME });
  app = await fx.app(users.alice, { SYNC_TRANSFER_LIMIT_MB: '0' });
});
afterEach(() => fx.cleanup());

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload: payload as object }) });
const get = (url: string) => app.inject({ method: 'GET', url });

function parseEvents(payload: string): Job[] {
  return payload
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => Job.parse(JSON.parse(block.slice(6))));
}

async function startJob(kind: 'copy' | 'move', body: object): Promise<string> {
  const res = await post(`/api/files/${kind}`, body);
  expect(res.statusCode).toBe(200);
  const parsed = TransferResponse.parse(res.json());
  expect(parsed.mode).toBe('job');
  return parsed.mode === 'job' ? parsed.jobId : '';
}

describe('transfer jobs', () => {
  it('runs large copies as jobs and reports progress and results', async () => {
    await fx.file('public/big.bin', Buffer.alloc(3 * MB, 7));
    await fx.file('public/docs/a.txt', 'A');
    await fx.file('public/docs/sub/b.txt', 'BB');
    const jobId = await startJob('copy', {
      items: [
        { share: 'public', path: '/big.bin' },
        { share: 'public', path: '/docs' },
      ],
      destination: { share: 'home', path: '/' },
    });
    await app.jobs.wait(jobId);

    const { job } = JobResponse.parse((await get(`/api/jobs/${jobId}`)).json());
    expect(job).toMatchObject({
      kind: 'copy',
      status: 'completed',
      totalItems: 2,
      doneItems: 2,
      totalBytes: 3 * MB + 3,
      doneBytes: 3 * MB + 3,
      currentItem: null,
      error: null,
    });
    expect(job.results.map((r) => [r.status, r.target?.path])).toEqual([
      ['done', '/big.bin'],
      ['done', '/docs'],
    ]);
    expect((await stat(path.join(fx.root, 'homes/alice/big.bin'))).size).toBe(3 * MB);
    expect(await readFile(path.join(fx.root, 'homes/alice/docs/sub/b.txt'), 'utf8')).toBe('BB');
    expect((await readdir(path.join(fx.root, 'homes/alice'))).sort()).toEqual(['big.bin', 'docs']);

    const list = JobsResponse.parse((await get('/api/jobs')).json());
    expect(list.jobs.map((j) => j.id)).toEqual([jobId]);
  });

  it('keeps small transfers synchronous under the default limit', async () => {
    const syncApp = await fx.app(users.alice);
    await fx.file('public/a.txt', 'A');
    const res = await syncApp.inject({
      method: 'POST',
      url: '/api/files/copy',
      payload: { items: [{ share: 'public', path: '/a.txt' }], destination: { share: 'home', path: '/' } },
    });
    expect(res.json().mode).toBe('sync');
  });

  it('moves with rename on the same file system and applies conflict strategies per item', async () => {
    await fx.file('homes/alice/x.txt', 'old');
    await fx.file('homes/alice/in/x.txt', 'new');
    await fx.file('homes/alice/in/y.txt', 'y');
    await fx.dir('homes/alice/out');
    await fx.file('homes/alice/out/x.txt', 'existing');
    // Same-device moves are cheap: they stay synchronous.
    let res = await post('/api/files/move', {
      items: [{ share: 'home', path: '/in/y.txt' }],
      destination: { share: 'home', path: '/out' },
    });
    expect(res.json().mode).toBe('sync');

    const jobId = await startJob('copy', {
      items: [
        { share: 'home', path: '/in/x.txt' },
        { share: 'home', path: '/x.txt' },
      ],
      destination: { share: 'home', path: '/out' },
      conflict: 'rename',
    });
    await app.jobs.wait(jobId);
    const job = app.jobs.get(users.alice.id, jobId);
    expect(job.results.map((r) => r.target?.path)).toEqual(['/out/x (1).txt', '/out/x (2).txt']);

    // Partial conflicts with "fail" are per-item failures; all-conflicting is a 409 up front.
    const partial = await startJob('copy', {
      items: [
        { share: 'home', path: '/in/x.txt' },
        { share: 'home', path: '/out/y.txt' },
      ],
      destination: { share: 'home', path: '/' },
    });
    await app.jobs.wait(partial);
    expect(app.jobs.get(users.alice.id, partial).results.map((r) => [r.status, r.error])).toEqual([
      ['failed', 'exists'],
      ['done', null],
    ]);
    res = await post('/api/files/copy', {
      items: [{ share: 'home', path: '/in/x.txt' }],
      destination: { share: 'home', path: '/' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.conflicts[0]).toMatchObject({ name: 'x.txt' });
  });

  it('cancels between chunks and removes the partial file', async () => {
    await fx.file('public/huge.bin', Buffer.alloc(16 * MB, 1));
    await fx.file('public/after.txt', 'later');
    const plan = await app.files.prepareTransfer('copy', users.alice, {
      items: [
        { share: 'public', path: '/huge.bin' },
        { share: 'public', path: '/after.txt' },
      ],
      destination: { share: 'home', path: '/' },
      conflict: 'fail',
    });
    const jobId = (await app.files.jobs!.maybeStart(users.alice, plan))!;
    const seen: Job[] = [];
    app.jobs.subscribe(users.alice.id, jobId, (job) => {
      seen.push(job);
      if (job.doneBytes > 0 && seen.filter((j) => j.doneBytes > 0).length === 1) {
        void app.jobs.cancel(users.alice.id, jobId);
      }
    });
    await app.jobs.wait(jobId);

    const res = await post(`/api/jobs/${jobId}/cancel`);
    const { job } = JobResponse.parse(res.json());
    expect(job.status).toBe('cancelled');
    expect(job.doneBytes).toBeLessThan(16 * MB);
    expect(job.results).toEqual([]);
    expect(await readdir(path.join(fx.root, 'homes/alice'))).toEqual([]);
  });

  it('hides jobs of other users (404)', async () => {
    const other = app.jobs.start(users.bob.id, { kind: 'copy', totalBytes: 0, totalItems: 0 }, async () => {});
    expect((await get(`/api/jobs/${other.id}`)).statusCode).toBe(404);
    expect((await get(`/api/jobs/${other.id}/events`)).statusCode).toBe(404);
    expect((await post(`/api/jobs/${other.id}/cancel`)).statusCode).toBe(404);
    expect((await get('/api/jobs/nope')).statusCode).toBe(404);
    expect(JobsResponse.parse((await get('/api/jobs')).json()).jobs).toEqual([]);
  });
});

describe('job events (SSE)', () => {
  it('streams the current state, throttled updates and the final state, then ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = app.jobs.start(users.alice.id, { kind: 'copy', totalBytes: 100, totalItems: 100 }, async (ctx) => {
      await gate;
      for (let i = 1; i <= 100; i++) ctx.update({ doneItems: i, doneBytes: i, currentItem: `/f${i}` });
    });
    const pending = get(`/api/jobs/${job.id}/events`);
    setTimeout(release, 20);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    const events = parseEvents(res.payload);
    expect(events[0]!.status).toMatch(/queued|running/);
    expect(events.length).toBeLessThan(10);
    expect(events.at(-1)).toMatchObject({ status: 'completed', doneItems: 100, currentItem: null });
    expect(app.jobs.listenerCount(job.id)).toBe(0);
  });

  it('sends a single event for finished jobs', async () => {
    const job = app.jobs.start(users.alice.id, { kind: 'move', totalBytes: 0, totalItems: 0 }, async () => {});
    await app.jobs.wait(job.id);
    const events = parseEvents((await get(`/api/jobs/${job.id}/events`)).payload);
    expect(events.map((e) => e.status)).toEqual(['completed']);
  });

  it('works over a real connection and cleans up when the client disconnects', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = app.jobs.start(users.alice.id, { kind: 'copy', totalBytes: 1, totalItems: 1 }, () => gate);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toMatch(/^data: \{/);
    await expect.poll(() => app.jobs.listenerCount(job.id)).toBe(1);
    controller.abort();
    await expect.poll(() => app.jobs.listenerCount(job.id)).toBe(0);
    release();
    await app.jobs.wait(job.id);
    app.server.closeAllConnections();
  });
});

describe('JobManager', () => {
  it('marks failed runners, keeps finished jobs for the retention period', async () => {
    const manager = new JobManager({ retentionMs: 1000 });
    const job = manager.start('u', { kind: 'copy', totalBytes: 0, totalItems: 0 }, async () => {
      throw new Error('disk full');
    });
    await manager.wait(job.id);
    expect(manager.get('u', job.id)).toMatchObject({ status: 'failed', error: 'disk full' });
    expect(() => manager.get('other', job.id)).toThrow('Job not found');
    manager.sweep(Date.now() + 500);
    expect(manager.list('u')).toHaveLength(1);
    manager.sweep(Date.now() + 5000);
    expect(manager.list('u')).toHaveLength(0);
    await manager.close();
  });

  it('cancels queued jobs before they start', async () => {
    const manager = new JobManager();
    let ran = false;
    const job = manager.start('u', { kind: 'copy', totalBytes: 0, totalItems: 0 }, async () => {
      ran = true;
    });
    const cancelled = await manager.cancel('u', job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(ran).toBe(false);
    await manager.close();
  });
});
