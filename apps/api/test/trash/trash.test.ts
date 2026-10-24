import { TrashListResponse } from '@wfb/contracts';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, users, type Fixture } from '../files/fixture.js';

let fx: Fixture;
let app: FastifyInstance;

const HOME =
  'home:\n  enabled: true\n  root: HOMES\n  name: Mi carpeta\n  permissions: [read, write, delete]\n';

beforeEach(async () => {
  fx = await createFixture({ yamlExtra: HOME });
  app = await fx.app(users.alice);
});
afterEach(() => fx.cleanup());

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });
const trashList = async (share = 'home') => {
  const res = await app.inject({ method: 'GET', url: `/api/trash?share=${share}` });
  expect(res.statusCode).toBe(200);
  return TrashListResponse.parse(res.json()).items;
};
const homeNames = async (rel = '') =>
  (await readdir(path.join(fx.root, 'homes/alice', rel))).filter((n) => n !== '.wfb-trash').sort();

describe('trash', () => {
  it('moves deleted entries to the trash and lists them', async () => {
    await fx.file('homes/alice/docs/a.txt', 'hello');
    await fx.file('homes/alice/dir/b.txt', 'abc');
    await fx.file('homes/alice/dir/c/d.txt', 'de');
    const res = await post('/api/files/delete', {
      items: [
        { share: 'home', path: '/docs/a.txt' },
        { share: 'home', path: '/dir' },
      ],
    });
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['trashed', 'trashed']);
    expect(await homeNames()).toEqual(['docs']);
    expect(await homeNames('docs')).toEqual([]);

    const items = await trashList();
    expect(items).toHaveLength(2);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName['a.txt']).toMatchObject({
      share: 'home',
      originalPath: '/docs/a.txt',
      type: 'file',
      size: 5,
      deletedBy: 'alice',
    });
    expect(byName['dir']).toMatchObject({ originalPath: '/dir', type: 'directory', size: 5 });
    expect(new Date(byName['dir']!.deletedAt).toISOString()).toBe(byName['dir']!.deletedAt);

    // Still hidden from listings and unreachable.
    const list = await app.inject({ method: 'GET', url: '/api/files?share=home&path=/' });
    expect(list.json().entries.map((e: { name: string }) => e.name)).toEqual(['docs']);
  });

  it('restores to the original path, recreating parents and renaming on conflict', async () => {
    await fx.file('homes/alice/docs/a.txt', 'first');
    await post('/api/files/delete', { items: [{ share: 'home', path: '/docs/a.txt' }] });
    await post('/api/files/delete', { items: [{ share: 'home', path: '/docs' }], permanent: true });
    await fx.file('homes/alice/b.txt', 'one');
    await post('/api/files/delete', { items: [{ share: 'home', path: '/b.txt' }] });
    await fx.file('homes/alice/b.txt', 'two');

    const ids = (await trashList()).map((i) => i.id);
    const res = await post('/api/trash/restore', { share: 'home', ids });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await readFile(path.join(fx.root, 'homes/alice/docs/a.txt'), 'utf8')).toBe('first');
    expect(await homeNames()).toEqual(['b (1).txt', 'b.txt', 'docs']);
    expect(await readFile(path.join(fx.root, 'homes/alice/b (1).txt'), 'utf8')).toBe('one');
    expect(await trashList()).toEqual([]);
  });

  it('purges selected items permanently', async () => {
    await fx.file('homes/alice/a.txt');
    await fx.file('homes/alice/b.txt');
    await post('/api/files/delete', {
      items: [
        { share: 'home', path: '/a.txt' },
        { share: 'home', path: '/b.txt' },
      ],
    });
    const items = await trashList();
    const a = items.find((i) => i.name === 'a.txt')!;
    let res = await post('/api/trash/purge', { share: 'home', ids: [a.id] });
    expect(res.statusCode).toBe(200);
    expect((await trashList()).map((i) => i.name)).toEqual(['b.txt']);
    res = await post('/api/trash/purge', { share: 'home', ids: items.map((i) => i.id) });
    expect(res.statusCode).toBe(200);
    expect(await trashList()).toEqual([]);
    expect(await readdir(path.join(fx.root, 'homes/alice/.wfb-trash'))).toEqual([]);
  });

  it('auto-purges entries older than 30 days', async () => {
    await fx.file('homes/alice/old.txt');
    await fx.file('homes/alice/new.txt');
    await post('/api/files/delete', {
      items: [
        { share: 'home', path: '/old.txt' },
        { share: 'home', path: '/new.txt' },
      ],
    });
    const old = (await trashList()).find((i) => i.name === 'old.txt')!;
    const metaPath = path.join(fx.root, 'homes/alice/.wfb-trash', old.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    meta.deletedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    await writeFile(metaPath, JSON.stringify(meta));
    const share = await app.shares.get(users.alice, 'home');
    expect(await app.trash.autoPurge(share, true)).toBe(1);
    expect((await trashList()).map((i) => i.name)).toEqual(['new.txt']);
  });

  it('checks permissions and validates ids', async () => {
    // public: read + write (no delete); finance: read only.
    expect((await app.inject({ method: 'GET', url: '/api/trash?share=public' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/trash?share=finance' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/trash?share=eng' })).statusCode).toBe(404);
    expect((await post('/api/trash/purge', { share: 'public', ids: ['lz1abcde-0011aabb'] })).statusCode).toBe(
      403,
    );
    expect(
      (await post('/api/trash/restore', { share: 'finance', ids: ['lz1abcde-0011aabb'] })).statusCode,
    ).toBe(403);
    expect((await post('/api/trash/restore', { share: 'home', ids: ['../../etc'] })).statusCode).toBe(400);
    expect((await post('/api/trash/restore', { share: 'home', ids: ['lz1abcde-0011aabb'] })).statusCode).toBe(
      404,
    );
    expect((await post('/api/trash/restore', { share: 'home', ids: [] })).statusCode).toBe(400);
  });

  it('ignores foreign folders and broken metadata in the trash dir', async () => {
    await mkdir(path.join(fx.root, 'homes/alice/.wfb-trash/not-an-id'), { recursive: true });
    await mkdir(path.join(fx.root, 'homes/alice/.wfb-trash/lz1abcde-0011aabb'), { recursive: true });
    await writeFile(path.join(fx.root, 'homes/alice/.wfb-trash/lz1abcde-0011aabb/meta.json'), '{oops');
    expect(await trashList()).toEqual([]);
  });
});
