import { EntryResponse, UploadSession } from '@wfb/contracts';
import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
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
  app = await fx.app(users.alice, { MAX_UPLOAD_MB: '20' });
});
afterEach(() => fx.cleanup());

const create = (body: object) => app.inject({ method: 'POST', url: '/api/uploads', payload: body });
const put = (id: string, offset: number, data: Buffer | string) =>
  app.inject({
    method: 'PUT',
    url: `/api/uploads/${id}?offset=${offset}`,
    payload: data,
    headers: { 'content-type': 'application/octet-stream' },
  });
const complete = (id: string) => app.inject({ method: 'POST', url: `/api/uploads/${id}/complete` });
const status = (id: string) => app.inject({ method: 'GET', url: `/api/uploads/${id}` });

async function start(name: string, size: number, extra: object = {}) {
  const res = await create({ share: 'home', path: '/', name, size, ...extra });
  expect(res.statusCode).toBe(201);
  return UploadSession.parse(res.json());
}

describe('resumable uploads', () => {
  it('uploads in chunks, resumes from the stored offset and completes atomically', async () => {
    const session = await start('video.bin', 10);
    expect(session).toMatchObject({ size: 10, offset: 0, chunkSize: 8 * 1024 * 1024 });
    let res = await put(session.id, 0, 'hello');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ offset: 5 });

    // A client that lost track asks for the offset, a stale chunk gets 409 with the current offset.
    expect(UploadSession.parse((await status(session.id)).json()).offset).toBe(5);
    res = await put(session.id, 0, 'hello');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ offset: 5 });

    res = await complete(session.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ offset: 5, size: 10 });

    expect((await put(session.id, 5, 'world')).json()).toMatchObject({ offset: 10 });
    expect(await readdir(path.join(fx.root, 'homes/alice'))).toEqual([]);
    res = await complete(session.id);
    expect(res.statusCode).toBe(200);
    expect(EntryResponse.parse(res.json()).entry).toMatchObject({
      name: 'video.bin',
      path: '/video.bin',
      size: 10,
    });
    expect(await readFile(path.join(fx.root, 'homes/alice/video.bin'), 'utf8')).toBe('helloworld');
    expect((await status(session.id)).statusCode).toBe(404);
    expect(await readdir(path.join(fx.tmp, 'data/uploads'))).toEqual([]);
  });

  it('rejects chunks beyond the declared size and oversized uploads', async () => {
    const session = await start('a.bin', 4);
    let res = await put(session.id, 0, 'too long');
    expect(res.statusCode).toBe(400);
    expect(UploadSession.parse((await status(session.id)).json()).offset).toBe(0);
    const MB = 1024 * 1024;
    const big = await start('chunks.bin', 9 * MB);
    res = await put(big.id, 0, Buffer.alloc(9 * MB));
    expect(res.statusCode).toBe(413);
    res = await put(big.id, 0, Buffer.alloc(8 * MB));
    expect(res.json()).toMatchObject({ offset: 8 * MB });
    res = await create({ share: 'home', path: '/', name: 'big.iso', size: 21 * 1024 * 1024 });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('requires a raw octet-stream body', async () => {
    const session = await start('a.bin', 4);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${session.id}?offset=0`,
      payload: { x: 1 },
    });
    expect(res.statusCode).toBe(415);
  });

  it('applies the conflict strategy at completion', async () => {
    await fx.file('homes/alice/r.txt', 'old');
    expect((await create({ share: 'home', path: '/', name: 'r.txt', size: 1 })).statusCode).toBe(409);

    const renamed = await start('r.txt', 1, { conflict: 'rename' });
    await put(renamed.id, 0, 'n');
    expect((await complete(renamed.id)).json().entry.path).toBe('/r (1).txt');

    const over = await start('r.txt', 3, { conflict: 'overwrite' });
    await put(over.id, 0, 'new');
    await complete(over.id);
    expect(await readFile(path.join(fx.root, 'homes/alice/r.txt'), 'utf8')).toBe('new');

    const skip = await start('r.txt', 1, { conflict: 'skip' });
    await put(skip.id, 0, 'x');
    expect((await complete(skip.id)).json().entry).toMatchObject({ path: '/r.txt', size: 3 });

    // Created meanwhile: "fail" is checked again at completion and the data is kept for a retry.
    const late = await start('late.txt', 1);
    await put(late.id, 0, 'l');
    await fx.file('homes/alice/late.txt', 'x');
    const res = await complete(late.id);
    expect(res.statusCode).toBe(409);
    expect(UploadSession.parse((await status(late.id)).json()).offset).toBe(1);
  });

  it('aborts uploads and hides them from other users', async () => {
    const session = await start('a.bin', 4);
    await expect(app.uploads.get(users.bob, session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const res = await app.inject({ method: 'DELETE', url: `/api/uploads/${session.id}` });
    expect(res.json()).toEqual({ ok: true });
    expect((await status(session.id)).statusCode).toBe(404);
    expect((await put(session.id, 0, 'abcd')).statusCode).toBe(404);
    expect((await status('not-an-id')).statusCode).toBe(404);
    expect(await readdir(path.join(fx.tmp, 'data/uploads'))).toEqual([]);
  });

  it('checks write permission and names', async () => {
    // finance is read-only for alice, eng is invisible.
    expect((await create({ share: 'finance', path: '/', name: 'a', size: 1 })).statusCode).toBe(403);
    expect((await create({ share: 'eng', path: '/', name: 'a', size: 1 })).statusCode).toBe(404);
    expect((await create({ share: 'home', path: '/', name: 'a/b', size: 1 })).statusCode).toBe(400);
    expect((await create({ share: 'home', path: '/', name: '.wfb-trash', size: 1 })).statusCode).toBe(400);
  });

  it('cleans up stale .part files without state', async () => {
    const live = await start('live.bin', 4);
    const dir = path.join(fx.tmp, 'data/uploads');
    const stale = path.join(dir, `${'a'.repeat(32)}.part`);
    await writeFile(stale, 'junk');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(stale, old, old);
    await utimes(path.join(dir, `${live.id}.part`), old, old);
    expect(await app.uploads.cleanupStale()).toBe(1);
    expect(await readdir(dir)).toEqual([`${live.id}.part`]);
  });
});
