import { ListResponse, SharesResponse, TransferResponse, UploadResponse } from '@wfb/contracts';
import { readdir, readFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFixture, multipart, users, type Fixture } from './fixture.js';

let fx: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fx = await createFixture({
    yamlExtra:
      'home:\n  enabled: true\n  root: HOMES\n  name: Mi carpeta\n  permissions: [read, write, delete]\n',
  });
  app = await fx.app(users.alice);
});
afterEach(() => fx.cleanup());

const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const list = async (share: string, p = '/') =>
  ListResponse.parse((await get(`/api/files?${q({ share, path: p })}`)).json());
const names = async (share: string, p = '/') => (await list(share, p)).entries.map((e) => e.name);

describe('GET /api/shares', () => {
  it('returns visible shares with effective permissions', async () => {
    const res = await get('/api/shares');
    expect(res.statusCode).toBe(200);
    const body = SharesResponse.parse(res.json());
    expect(body.shares.map((s) => [s.id, s.permissions])).toEqual([
      ['home', ['read', 'write', 'delete']],
      ['public', ['read', 'write']],
      ['finance', ['read']],
    ]);
  });
});

describe('listing and stat', () => {
  it('lists sorted entries with metadata, hiding the trash', async () => {
    await fx.file('public/b.txt', 'bb');
    await fx.file('public/A.png', 'img');
    await fx.file('public/.hidden', 'x');
    await fx.dir('public/zdir');
    await fx.file('public/.wfb-trash/x.txt');
    const body = await list('public');
    expect(body).toMatchObject({ share: 'public', path: '/' });
    expect(body.entries.map((e) => e.name)).toEqual(['zdir', '.hidden', 'A.png', 'b.txt']);
    expect(body.entries[0]).toMatchObject({ type: 'directory', size: 0, mime: null, path: '/zdir' });
    expect(body.entries[3]).toMatchObject({ type: 'file', size: 2, mime: 'text/plain', previewable: true });
    expect(new Date(body.entries[3]!.modifiedAt).toISOString()).toBe(body.entries[3]!.modifiedAt);
  });

  it('stats entries and the root', async () => {
    await fx.file('public/docs/r.pdf', '%PDF');
    let res = await get(`/api/files/stat?${q({ share: 'public', path: 'docs//r.pdf' })}`);
    expect(res.json().entry).toMatchObject({ name: 'r.pdf', path: '/docs/r.pdf', mime: 'application/pdf' });
    res = await get(`/api/files/stat?${q({ share: 'public', path: '/' })}`);
    expect(res.json().entry).toMatchObject({ name: 'Público', path: '/', type: 'directory' });
  });

  it('returns 404 for invisible or unknown shares and missing files', async () => {
    expect((await get(`/api/files?${q({ share: 'eng', path: '/' })}`)).statusCode).toBe(404);
    expect((await get(`/api/files?${q({ share: 'nope', path: '/' })}`)).statusCode).toBe(404);
    const res = await get(`/api/files?${q({ share: 'public', path: '/missing' })}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects ".." with 400 and symlink escapes', async () => {
    let res = await get(`/api/files?${q({ share: 'public', path: '/../eng' })}`);
    expect(res.statusCode).toBe(400);
    await fx.file('eng/secret.txt', 'top secret');
    await symlink(path.join(fx.root, 'eng'), path.join(fx.root, 'public', 'eng-link'));
    await symlink('/etc', path.join(fx.root, 'public', 'etc'));
    expect(await names('public')).toEqual([]);
    res = await get(`/api/files?${q({ share: 'public', path: '/eng-link' })}`);
    expect(res.statusCode).toBe(403);
    res = await get(`/api/files/download?${q({ share: 'public', path: '/eng-link/secret.txt' })}`);
    expect(res.statusCode).toBe(403);
    res = await get(`/api/files/download?${q({ share: 'public', path: '/etc/passwd' })}`);
    expect(res.statusCode).toBe(403);
  });

  it('makes the trash dir inaccessible', async () => {
    await fx.file('public/.wfb-trash/x.txt');
    expect((await get(`/api/files?${q({ share: 'public', path: '/.wfb-trash' })}`)).statusCode).toBe(404);
    const res = await get(`/api/files/download?${q({ share: 'public', path: '/.wfb-trash/x.txt' })}`);
    expect(res.statusCode).toBe(404);
    expect(
      (await post('/api/files/mkdir', { share: 'public', path: '/', name: '.wfb-trash' })).statusCode,
    ).toBe(400);
  });

  it('creates the home folder on first access', async () => {
    expect(await names('home')).toEqual([]);
    expect((await stat(path.join(fx.root, 'homes', 'alice'))).isDirectory()).toBe(true);
  });
});

describe('mkdir and rename', () => {
  it('creates folders, 409 on conflict, 403 without write', async () => {
    let res = await post('/api/files/mkdir', { share: 'public', path: '/', name: 'Nueva carpeta' });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry).toMatchObject({
      name: 'Nueva carpeta',
      path: '/Nueva carpeta',
      type: 'directory',
    });
    res = await post('/api/files/mkdir', { share: 'public', path: '/', name: 'Nueva carpeta' });
    expect(res.statusCode).toBe(409);
    res = await post('/api/files/mkdir', { share: 'finance', path: '/', name: 'x' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    res = await post('/api/files/mkdir', { share: 'public', path: '/missing', name: 'x' });
    expect(res.statusCode).toBe(404);
  });

  it('read-only public share forbids writes for users outside the acl', async () => {
    const carol = await fx.app(users.carol);
    const res = await carol.inject({
      method: 'POST',
      url: '/api/files/mkdir',
      payload: { share: 'public', path: '/', name: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renames, rejecting slashes, conflicts and the root', async () => {
    await fx.file('public/a.txt');
    await fx.file('public/b.txt');
    let res = await post('/api/files/rename', { share: 'public', path: '/a.txt', newName: 'c.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry).toMatchObject({ name: 'c.txt', path: '/c.txt' });
    res = await post('/api/files/rename', { share: 'public', path: '/c.txt', newName: 'b.txt' });
    expect(res.statusCode).toBe(409);
    res = await post('/api/files/rename', { share: 'public', path: '/c.txt', newName: 'x/y.txt' });
    expect(res.statusCode).toBe(400);
    res = await post('/api/files/rename', { share: 'public', path: '/', newName: 'root' });
    expect(res.statusCode).toBe(400);
    expect(await names('public')).toEqual(['b.txt', 'c.txt']);
  });
});

describe('copy and move', () => {
  const transfer = async (kind: 'copy' | 'move', body: object) => {
    const res = await post(`/api/files/${kind}`, body);
    return { res, body: res.statusCode === 200 ? TransferResponse.parse(res.json()) : null };
  };

  beforeEach(async () => {
    await fx.file('homes/alice/report.pdf', 'R1');
    await fx.file('public/report.pdf', 'R0');
    await fx.file('public/docs/notes.txt', 'N');
  });

  it('copies across shares and applies conflict strategies', async () => {
    await names('home');
    const items = [{ share: 'public', path: '/report.pdf' }];
    const destination = { share: 'home', path: '/' };

    const fail = await transfer('copy', { items, destination });
    expect(fail.res.statusCode).toBe(409);
    expect(fail.res.json().error.details.conflicts).toEqual([
      { name: 'report.pdf', source: items[0], target: { share: 'home', path: '/report.pdf' } },
    ]);

    const skip = await transfer('copy', { items, destination, conflict: 'skip' });
    expect(skip.body).toEqual({
      mode: 'sync',
      results: [{ source: items[0], status: 'skipped', target: null, error: null }],
    });

    const renamed = await transfer('copy', { items, destination, conflict: 'rename' });
    expect(renamed.body!.mode === 'sync' && renamed.body!.results[0]!.target).toEqual({
      share: 'home',
      path: '/report (1).pdf',
    });
    await transfer('copy', { items, destination, conflict: 'rename' });
    expect((await names('home')).sort()).toEqual(['report (1).pdf', 'report (2).pdf', 'report.pdf']);

    const over = await transfer('copy', { items, destination, conflict: 'overwrite' });
    expect(over.res.statusCode).toBe(200);
    expect(await readFile(path.join(fx.root, 'homes/alice/report.pdf'), 'utf8')).toBe('R0');
  });

  it('reports per-item failures when only some items conflict', async () => {
    await fx.file('homes/alice/x.txt');
    await names('home');
    const { res, body } = await transfer('copy', {
      items: [
        { share: 'public', path: '/report.pdf' },
        { share: 'public', path: '/docs' },
      ],
      destination: { share: 'home', path: '/' },
    });
    expect(res.statusCode).toBe(200);
    expect(body!.mode === 'sync' && body!.results.map((r) => [r.status, r.error])).toEqual([
      ['failed', 'exists'],
      ['done', null],
    ]);
    expect(await readFile(path.join(fx.root, 'homes/alice/docs/notes.txt'), 'utf8')).toBe('N');
  });

  it('overwrites folders (replace) and copies a file next to itself with rename', async () => {
    await fx.file('homes/alice/docs/old.txt');
    await transfer('copy', {
      items: [{ share: 'public', path: '/docs' }],
      destination: { share: 'home', path: '/' },
      conflict: 'overwrite',
    });
    expect(await readdir(path.join(fx.root, 'homes/alice/docs'))).toEqual(['notes.txt']);
    const { body } = await transfer('copy', {
      items: [{ share: 'public', path: '/report.pdf' }],
      destination: { share: 'public', path: '/' },
      conflict: 'rename',
    });
    expect(body!.mode === 'sync' && body!.results[0]!.target?.path).toBe('/report (1).pdf');
  });

  it('refuses copying or moving a folder into itself or a descendant', async () => {
    await fx.dir('homes/alice/docs/sub');
    for (const kind of ['copy', 'move'] as const) {
      for (const dest of ['/docs', '/docs/sub']) {
        const { res } = await transfer(kind, {
          items: [{ share: 'home', path: '/docs' }],
          destination: { share: 'home', path: dest },
        });
        expect(res.statusCode).toBe(400);
      }
    }
    const { res } = await transfer('copy', {
      items: [{ share: 'public', path: '/' }],
      destination: { share: 'home', path: '/' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('moves across shares and treats same-location moves as skipped', async () => {
    const bob = await fx.app(users.bob);
    await fx.file('eng/spec.md', '# spec');
    let res = await bob.inject({
      method: 'POST',
      url: '/api/files/move',
      payload: {
        items: [{ share: 'eng', path: '/spec.md' }],
        destination: { share: 'public', path: '/docs' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({
      status: 'done',
      target: { share: 'public', path: '/docs/spec.md' },
    });
    expect(await readdir(path.join(fx.root, 'eng'))).toEqual([]);
    expect(await readFile(path.join(fx.root, 'public/docs/spec.md'), 'utf8')).toBe('# spec');

    res = await post('/api/files/move', {
      items: [{ share: 'home', path: '/report.pdf' }],
      destination: { share: 'home', path: '/' },
    });
    expect(res.json().results[0]).toMatchObject({
      status: 'skipped',
      target: { share: 'home', path: '/report.pdf' },
    });
  });

  it('checks permissions: move needs delete on source, write on destination', async () => {
    await fx.file('finance/q1.xlsx');
    let res = await post('/api/files/move', {
      items: [{ share: 'finance', path: '/q1.xlsx' }],
      destination: { share: 'public', path: '/' },
    });
    expect(res.statusCode).toBe(403);
    res = await post('/api/files/copy', {
      items: [{ share: 'public', path: '/report.pdf' }],
      destination: { share: 'finance', path: '/' },
    });
    expect(res.statusCode).toBe(403);
    res = await post('/api/files/copy', {
      items: [{ share: 'finance', path: '/q1.xlsx' }],
      destination: { share: 'public', path: '/' },
    });
    expect(res.statusCode).toBe(200);
    res = await post('/api/files/copy', {
      items: [{ share: 'eng', path: '/x' }],
      destination: { share: 'public', path: '/' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reports missing sources per item', async () => {
    const { body } = await transfer('copy', {
      items: [{ share: 'public', path: '/ghost.txt' }],
      destination: { share: 'home', path: '/' },
    });
    expect(body!.mode === 'sync' && body!.results[0]).toMatchObject({ status: 'failed', error: 'not_found' });
  });
});

describe('delete', () => {
  it('deletes permanently and refuses the root and missing permission', async () => {
    await fx.file('homes/alice/a.txt');
    await fx.file('homes/alice/dir/b.txt');
    let res = await post('/api/files/delete', {
      items: [
        { share: 'home', path: '/a.txt' },
        { share: 'home', path: '/dir' },
        { share: 'home', path: '/ghost' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual([
      'deleted',
      'deleted',
      'failed',
    ]);
    expect(await readdir(path.join(fx.root, 'homes/alice'))).toEqual([]);
    res = await post('/api/files/delete', { items: [{ share: 'home', path: '/' }] });
    expect(res.statusCode).toBe(400);
    await fx.file('public/p.txt');
    res = await post('/api/files/delete', { items: [{ share: 'public', path: '/p.txt' }], permanent: true });
    expect(res.statusCode).toBe(403);
  });
});

describe('upload', () => {
  const upload = (query: Record<string, string>, files: Parameters<typeof multipart>[0], a = app) => {
    const { payload, headers } = multipart(files);
    return a.inject({ method: 'POST', url: `/api/files/upload?${q(query)}`, payload, headers });
  };

  it('stores multiple files and sanitizes names', async () => {
    const res = await upload({ share: 'home', path: '/' }, [
      { name: 'uno.txt', content: '1' },
      { name: '../../evil.txt', content: '2' },
      { name: 'ignored.txt', content: 'x', field: 'other' },
    ]);
    expect(res.statusCode).toBe(200);
    const body = UploadResponse.parse(res.json());
    expect(body.entries.map((e) => [e.path, e.size])).toEqual([
      ['/uno.txt', 1],
      ['/evil.txt', 1],
    ]);
    expect((await readdir(path.join(fx.root, 'homes/alice'))).sort()).toEqual(['evil.txt', 'uno.txt']);
    expect((await upload({ share: 'home', path: '/' }, [{ name: '..', content: 'x' }])).statusCode).toBe(400);
  });

  it('applies conflict strategies', async () => {
    await fx.file('homes/alice/a.txt', 'old');
    const ref = { share: 'home', path: '/' };
    let res = await upload(ref, [{ name: 'a.txt', content: 'new' }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ conflicts: [{ name: 'a.txt' }] });
    res = await upload({ ...ref, conflict: 'skip' }, [{ name: 'a.txt', content: 'new' }]);
    expect(res.json()).toEqual({ entries: [] });
    res = await upload({ ...ref, conflict: 'rename' }, [{ name: 'a.txt', content: 'new' }]);
    expect(res.json().entries[0].name).toBe('a (1).txt');
    res = await upload({ ...ref, conflict: 'overwrite' }, [{ name: 'a.txt', content: 'newer' }]);
    expect(res.statusCode).toBe(200);
    expect(await readFile(path.join(fx.root, 'homes/alice/a.txt'), 'utf8')).toBe('newer');
  });

  it('rejects oversized files with 413 and removes the partial file', async () => {
    const small = await fx.app(users.alice, { MAX_UPLOAD_MB: '0.001' });
    const res = await upload(
      { share: 'home', path: '/' },
      [{ name: 'big.bin', content: Buffer.alloc(5000, 1) }],
      small,
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await readdir(path.join(fx.root, 'homes/alice'))).toEqual([]);
    const huge = await upload(
      { share: 'home', path: '/' },
      [{ name: 'huge.bin', content: Buffer.alloc(2 * 1024 * 1024, 1) }],
      small,
    );
    expect(huge.statusCode).toBe(413);
    expect(await readdir(path.join(fx.root, 'homes/alice'))).toEqual([]);
    const ok = await upload(
      { share: 'home', path: '/' },
      [{ name: 'ok.bin', content: Buffer.alloc(1000) }],
      small,
    );
    expect(ok.statusCode).toBe(200);
  });

  it('streams files larger than the JSON body limit', async () => {
    const big = Buffer.alloc(12 * 1024 * 1024, 7);
    const res = await upload({ share: 'home', path: '/' }, [{ name: 'big.bin', content: big }]);
    expect(res.statusCode).toBe(200);
    expect((await stat(path.join(fx.root, 'homes/alice/big.bin'))).size).toBe(big.length);
  });

  it('requires write permission and a folder destination', async () => {
    await fx.file('public/f.txt');
    const carol = await fx.app(users.carol);
    expect(
      (await upload({ share: 'public', path: '/' }, [{ name: 'x', content: 'x' }], carol)).statusCode,
    ).toBe(403);
    expect(
      (await upload({ share: 'public', path: '/f.txt' }, [{ name: 'x', content: 'x' }])).statusCode,
    ).toBe(400);
  });
});

describe('download', () => {
  const dl = (p: string, headers: Record<string, string> = {}, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/api/files/download?${q({ share: 'public', path: p, ...extra })}`,
      headers,
    });

  beforeEach(async () => {
    await fx.file('public/digits.txt', '0123456789');
    await fx.file('public/photo.jpg', 'jpeg');
    await fx.file('public/page.html', '<script>alert(1)</script>');
    await fx.file('public/icon.svg', '<svg/>');
    await fx.file('public/informe año.pdf', '%PDF');
    await fx.dir('public/folder');
  });

  it('serves the whole file with headers', async () => {
    const res = await dl('/digits.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('0123456789');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('10');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="digits.txt"; filename*=UTF-8''digits.txt`,
    );
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers['last-modified']).toBeTruthy();
  });

  it('supports ranges and 416', async () => {
    let res = await dl('/digits.txt', { range: 'bytes=2-5' });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    res = await dl('/digits.txt', { range: 'bytes=7-' });
    expect(res.body).toBe('789');
    res = await dl('/digits.txt', { range: 'bytes=-3' });
    expect(res.body).toBe('789');
    expect(res.headers['content-range']).toBe('bytes 7-9/10');
    res = await dl('/digits.txt', { range: 'bytes=5-100' });
    expect(res.headers['content-range']).toBe('bytes 5-9/10');
    res = await dl('/digits.txt', { range: 'bytes=10-' });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
    res = await dl('/digits.txt', { range: 'bytes=0-1,4-5' });
    expect(res.statusCode).toBe(200);
  });

  it('answers 304 for matching ETag', async () => {
    const first = await dl('/digits.txt');
    const res = await dl('/digits.txt', { 'if-none-match': String(first.headers.etag) });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
  });

  it('inlines only safe types', async () => {
    const disposition = async (p: string, inline = 'true') =>
      String((await dl(p, {}, { inline })).headers['content-disposition']).split(';')[0];
    expect(await disposition('/photo.jpg')).toBe('inline');
    expect(await disposition('/digits.txt')).toBe('inline');
    expect(await disposition('/informe año.pdf')).toBe('inline');
    expect(await disposition('/photo.jpg', 'false')).toBe('attachment');
    expect(await disposition('/page.html')).toBe('attachment');
    expect(await disposition('/icon.svg')).toBe('attachment');
    const res = await dl('/page.html', {}, { inline: 'true' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('encodes non-ASCII names with RFC 5987', async () => {
    const res = await dl('/informe año.pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="informe a_o.pdf"; filename*=UTF-8''informe%20a%C3%B1o.pdf`,
    );
  });

  it('rejects folders and missing files', async () => {
    expect((await dl('/folder')).statusCode).toBe(400);
    expect((await dl('/nope.txt')).statusCode).toBe(404);
  });
});

describe('decorators', () => {
  it('exposes shares and resolveRef', async () => {
    await fx.file('public/a.txt');
    const ref = await app.resolveRef(users.alice, { share: 'public', path: '/a.txt' }, 'read');
    expect(ref).toMatchObject({ shareId: 'public', virtualPath: '/a.txt' });
    expect(ref.absPath.endsWith(path.join('public', 'a.txt'))).toBe(true);
    await expect(
      app.resolveRef(users.alice, { share: 'public', path: '/a.txt' }, 'delete'),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(app.shares.listForUser(users.carol).map((s) => s.id)).toEqual(['home', 'public']);
  });
});
