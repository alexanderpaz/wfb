import { CSRF_HEADER, routes, SESSION_COOKIE, type RouteDef, type User } from '@wfb/contracts';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { MemoryStore } from '../../src/lib/kv.js';
import { createFixture, multipart, users, type Fixture } from '../files/fixture.js';
import { testConfig } from '../helpers.js';

const ID = '0123456789abcdef0123456789abcdef';
const ref = { share: 'public', path: '/a.txt' };

/** A request for `route` whose input is valid enough to reach the auth checks. */
function requestFor(route: RouteDef): InjectOptions {
  const url = `/api${route.path.replace(':id', ID)}?share=public&path=/a.txt&q=a&offset=0`;
  if (route.method === 'GET') return { method: 'GET', url };
  if (route.method === 'PUT') {
    return {
      method: 'PUT',
      url,
      payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream' },
    };
  }
  return { method: route.method, url, payload: { ...ref, items: [ref], destination: ref, name: 'n' } };
}

const protectedRoutes = Object.entries(routes).filter(([, r]) => r.auth) as [string, RouteDef][];
const mutatingRoutes = protectedRoutes.filter(([, r]) => r.method !== 'GET');

describe('authentication and CSRF on every protected route', () => {
  let app: FastifyInstance;
  let kv: MemoryStore;
  let fx: Fixture;
  let cookie: string;
  const csrf = 'the-csrf-token-of-this-session';

  beforeEach(async () => {
    fx = await createFixture();
    kv = new MemoryStore();
    app = await buildApp({
      config: testConfig({ SHARES_CONFIG: fx.yamlPath, DATA_DIR: path.join(fx.tmp, 'data') }),
      services: { kv, prisma: null },
    });
    await kv.set('sess:security-test-session-0001', JSON.stringify({ user: users.alice, csrfToken: csrf }));
    cookie = `${SESSION_COOKIE}=${app.signCookie('security-test-session-0001')}`;
  });
  afterEach(async () => {
    await app.close();
    await fx.cleanup();
  });

  it('covers the whole contract', () => {
    expect(protectedRoutes.length).toBeGreaterThan(20);
    expect(mutatingRoutes.map(([name]) => name)).toEqual(
      expect.arrayContaining(['mkdir', 'rename', 'copy', 'move', 'delete', 'upload', 'logout']),
    );
  });

  it.each(protectedRoutes)('%s is 401 without a session', async (_name, route) => {
    const res = await app.inject(requestFor(route));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it.each(protectedRoutes)('%s is 401 with a forged session cookie', async (_name, route) => {
    const req = requestFor(route);
    const res = await app.inject({
      ...req,
      headers: {
        ...req.headers,
        cookie: `${SESSION_COOKIE}=security-test-session-0001`,
        [CSRF_HEADER]: csrf,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it.each(mutatingRoutes)('%s is 403 CSRF without or with a wrong token', async (_name, route) => {
    const req = requestFor(route);
    for (const token of [undefined, 'wrong', `${csrf}x`, csrf.toUpperCase()]) {
      const headers = { ...req.headers, cookie, ...(token ? { [CSRF_HEADER]: token } : {}) };
      const res = await app.inject({ ...req, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF');
    }
  });

  it('accepts the right token (sanity check of the matrix)', async () => {
    await fx.file('public/a.txt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/mkdir',
      payload: { share: 'public', path: '/', name: 'ok' },
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('share ACL on every route', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.file('public/a.txt', 'public');
    await fx.file('public/img.png', 'not really a png');
    await fx.file('finance/budget.csv', 'secret numbers');
    await fx.file('finance/img.png', 'x');
    await fx.file('eng/design.txt', 'eng only');
    await fx.file('eng/img.png', 'x');
  });
  afterEach(() => fx.cleanup());

  /** Every route touching `share`/`file` with the given permission need. */
  function reads(share: string, file: string): InjectOptions[] {
    const q = `share=${share}&path=${encodeURIComponent(file)}`;
    return [
      { method: 'GET', url: `/api/files?share=${share}&path=/` },
      { method: 'GET', url: `/api/files/stat?${q}` },
      { method: 'GET', url: `/api/files/download?${q}` },
      { method: 'GET', url: `/api/search?share=${share}&path=/&q=a` },
      { method: 'GET', url: `/api/preview/info?${q}` },
      { method: 'GET', url: `/api/preview/content?${q}` },
      { method: 'GET', url: `/api/preview/thumbnail?share=${share}&path=/img.png` },
    ];
  }

  function writes(share: string, file: string): InjectOptions[] {
    const item = { share, path: file };
    const upload = multipart([{ name: 'new.txt', content: 'x' }]);
    return [
      { method: 'POST', url: '/api/files/mkdir', payload: { share, path: '/', name: 'new' } },
      { method: 'POST', url: '/api/files/rename', payload: { ...item, newName: 'renamed.txt' } },
      { method: 'POST', url: '/api/files/delete', payload: { items: [item] } },
      { method: 'POST', url: '/api/files/delete', payload: { items: [item], permanent: true } },
      {
        method: 'POST',
        url: '/api/files/move',
        payload: { items: [item], destination: { share, path: '/' } },
      },
      {
        method: 'POST',
        url: `/api/files/upload?share=${share}&path=/`,
        payload: upload.payload,
        headers: upload.headers,
      },
      { method: 'POST', url: '/api/uploads', payload: { share, path: '/', name: 'new.txt', size: 1 } },
      {
        method: 'POST',
        url: '/api/files/copy',
        payload: { items: [ref], destination: { share, path: '/' } },
      },
      { method: 'POST', url: '/api/trash/restore', payload: { share, ids: ['lz1abcde-0011aabb'] } },
      { method: 'POST', url: '/api/trash/purge', payload: { share, ids: ['lz1abcde-0011aabb'] } },
    ];
  }

  async function statuses(user: User, reqs: InjectOptions[]) {
    const app = await fx.app(user);
    const out: number[] = [];
    for (const req of reqs) out.push((await app.inject(req)).statusCode);
    return out;
  }

  it('a private share without access is invisible (404) for reads, writes and trash', async () => {
    const reqs = [...reads('eng', '/design.txt'), ...writes('eng', '/design.txt')];
    reqs.push({ method: 'GET', url: '/api/trash?share=eng' });
    for (const user of [users.alice, users.carol]) {
      const got = await statuses(user, reqs);
      expect(got.map((s, i) => `${reqs[i]!.url} ${s}`)).toEqual(reqs.map((r) => `${r.url} 404`));
    }
    // Copying out of the invisible share into a writable one (alice: public rw).
    const copyOut = {
      method: 'POST' as const,
      url: '/api/files/copy',
      payload: {
        items: [{ share: 'eng', path: '/design.txt' }],
        destination: { share: 'public', path: '/' },
      },
    };
    expect(await statuses(users.alice, [copyOut])).toEqual([404]);
    const shares = (await (await fx.app(users.alice)).inject({ method: 'GET', url: '/api/shares' })).json();
    expect(shares.shares.map((s: { id: string }) => s.id)).not.toContain('eng');
    expect(await readFile(path.join(fx.root, 'eng/design.txt'), 'utf8')).toBe('eng only');
  });

  it('read-only users can read but get 403 on every write', async () => {
    // alice: finance read-only. carol: public read-only.
    for (const [user, share, file] of [
      [users.alice, 'finance', '/budget.csv'],
      [users.carol, 'public', '/a.txt'],
    ] as const) {
      const readStatuses = await statuses(user, reads(share, file));
      expect(readStatuses.every((s) => s === 200 || s === 415)).toBe(true);
      const w = writes(share, file);
      expect(await statuses(user, w)).toEqual(w.map(() => 403));
    }
    expect(await readdir(path.join(fx.root, 'finance'))).toEqual(['budget.csv', 'img.png']);
    expect(await readdir(path.join(fx.root, 'public'))).toEqual(['a.txt', 'img.png']);
  });

  it('cross-share copy/move into or out of a read-only share is denied', async () => {
    const app = await fx.app(users.alice);
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
    const toFinance = { items: [ref], destination: { share: 'finance', path: '/' } };
    const fromFinance = {
      items: [{ share: 'finance', path: '/budget.csv' }],
      destination: { share: 'public', path: '/' },
    };
    expect((await post('/api/files/copy', toFinance)).statusCode).toBe(403);
    expect((await post('/api/files/move', toFinance)).statusCode).toBe(403);
    // Moving out needs delete on the source share.
    expect((await post('/api/files/move', fromFinance)).statusCode).toBe(403);
    // Copying out only needs read.
    expect((await post('/api/files/copy', fromFinance)).statusCode).toBe(200);
    expect(await readdir(path.join(fx.root, 'finance'))).toEqual(['budget.csv', 'img.png']);
    // public: alice has write but no delete, so she cannot move anything out of it.
    await fx.dir('public/sub');
    const fromPublic = { items: [ref], destination: { share: 'public', path: '/sub' } };
    expect((await post('/api/files/move', fromPublic)).statusCode).toBe(403);
    expect(await readFile(path.join(fx.root, 'public/a.txt'), 'utf8')).toBe('public');
  });

  it('write-only drop boxes are not exposed through any route', async () => {
    await fx.file('dropbox/cv.pdf', 'x');
    const reqs = [...reads('dropbox', '/cv.pdf'), ...writes('dropbox', '/cv.pdf')];
    expect(await statuses(users.carol, reqs)).toEqual(reqs.map(() => 404));
  });

  it('uploads and jobs are only visible to their owner', async () => {
    const kv = new MemoryStore();
    const app = await buildApp({
      config: testConfig({
        SHARES_CONFIG: fx.yamlPath,
        DATA_DIR: path.join(fx.tmp, 'data'),
        SYNC_TRANSFER_LIMIT_MB: '0',
      }),
      services: { kv, prisma: null },
    });
    try {
      const as = async (user: User) => {
        const id = `session-of-${user.username.toLowerCase()}-0000000000`;
        await kv.set(`sess:${id}`, JSON.stringify({ user, csrfToken: `csrf-${id}` }));
        const headers = { cookie: `${SESSION_COOKIE}=${app.signCookie(id)}`, [CSRF_HEADER]: `csrf-${id}` };
        return (req: InjectOptions) => app.inject({ ...req, headers: { ...req.headers, ...headers } });
      };
      const alice = await as(users.alice);
      const bob = await as(users.bob);

      const created = await alice({
        method: 'POST',
        url: '/api/uploads',
        payload: { share: 'public', path: '/', name: 'u.bin', size: 1 },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const chunk = {
        payload: Buffer.from('x'),
        headers: { 'content-type': 'application/octet-stream' },
      };
      for (const req of [
        { method: 'GET', url: `/api/uploads/${id}` },
        { method: 'PUT', url: `/api/uploads/${id}?offset=0`, ...chunk },
        { method: 'POST', url: `/api/uploads/${id}/complete` },
        { method: 'DELETE', url: `/api/uploads/${id}` },
      ] as InjectOptions[]) {
        expect((await bob(req)).statusCode).toBe(404);
      }
      expect((await alice({ method: 'GET', url: `/api/uploads/${id}` })).json().offset).toBe(0);

      const job = await alice({
        method: 'POST',
        url: '/api/files/copy',
        payload: { items: [ref], destination: { share: 'public', path: '/' }, conflict: 'rename' },
      });
      expect(job.json().mode).toBe('job');
      const jobId = job.json().jobId as string;
      for (const url of [`/api/jobs/${jobId}`, `/api/jobs/${jobId}/events`]) {
        expect((await bob({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect((await bob({ method: 'POST', url: `/api/jobs/${jobId}/cancel` })).statusCode).toBe(404);
      expect((await bob({ method: 'GET', url: '/api/jobs' })).json().jobs).toEqual([]);
      expect((await alice({ method: 'GET', url: `/api/jobs/${jobId}` })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('path traversal', () => {
  let fx: Fixture;
  let app: FastifyInstance;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.file('public/a.txt', 'public');
    await writeFile(path.join(fx.tmp, 'secret.txt'), 'outside the shares');
    app = await fx.app(users.alice);
  });
  afterEach(() => fx.cleanup());

  const evilPaths = [
    '..',
    '../',
    '/../secret.txt',
    '/../../secret.txt',
    'a/../../secret.txt',
    '..\\..\\secret.txt',
    '/a.txt/../../secret.txt',
    '/a\0.txt',
  ];

  it.each(evilPaths)('rejects %j on read routes', async (p) => {
    for (const route of [
      '/api/files',
      '/api/files/stat',
      '/api/files/download',
      '/api/preview/content',
      '/api/search',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: route,
        query: { share: 'public', path: p, q: 'a' },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects URL-encoded and double-encoded traversal', async () => {
    for (const raw of [
      '%2e%2e%2fsecret.txt',
      '%2E%2E%5Csecret.txt',
      '..%2f..%2fsecret.txt',
      '%2e%2e/%2e%2e/x',
    ]) {
      const res = await app.inject({ method: 'GET', url: `/api/files/download?share=public&path=${raw}` });
      expect(res.statusCode).toBe(400);
    }
    // Double encoding decodes once to a literal "%2e%2e" name, which simply does not exist.
    const double = await app.inject({
      method: 'GET',
      url: '/api/files/download?share=public&path=%252e%252e%252fsecret.txt',
    });
    expect(double.statusCode).toBe(404);
  });

  it('treats absolute and unicode look-alike paths as names inside the share', async () => {
    for (const p of [
      path.join(fx.tmp, 'secret.txt'),
      '/etc/passwd',
      '/\uff0e\uff0e/secret.txt',
      '/\u2024\u2024/secret.txt',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/files/download',
        query: { share: 'public', path: p },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('rejects traversal in share ids', async () => {
    for (const share of ['../eng', 'public/../eng', '..', 'PUBLIC']) {
      const res = await app.inject({ method: 'GET', url: '/api/files', query: { share, path: '/' } });
      expect(res.statusCode).toBe(404);
    }
  });

  it.each([
    '..',
    '.',
    '../x',
    'a/b',
    'a\\b',
    'x\0y',
    '.wfb-trash',
    '.WFB-Trash',
    '.wfb-upload-0123456789abcdef.tmp',
  ])('rejects the new name %j for mkdir, rename and resumable uploads', async (name) => {
    const mk = await app.inject({
      method: 'POST',
      url: '/api/files/mkdir',
      payload: { share: 'public', path: '/', name },
    });
    expect(mk.statusCode).toBe(400);
    const rn = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      payload: { share: 'public', path: '/a.txt', newName: name },
    });
    expect(rn.statusCode).toBe(400);
    const up = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      payload: { share: 'public', path: '/', name, size: 1 },
    });
    expect(up.statusCode).toBe(400);
  });

  it('reduces multipart file names to a safe basename', async () => {
    for (const name of ['../../escape1.txt', '..\\..\\escape2.txt', '/abs/escape3.txt']) {
      const { payload, headers } = multipart([{ name, content: 'x' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/files/upload?share=public&path=/',
        payload,
        headers,
      });
      expect(res.statusCode).toBe(200);
    }
    expect((await readdir(path.join(fx.root, 'public'))).sort()).toEqual([
      'a.txt',
      'escape1.txt',
      'escape2.txt',
      'escape3.txt',
    ]);
    expect(await readdir(fx.tmp)).not.toContain('escape1.txt');
    expect(await readdir(fx.root)).not.toContain('escape1.txt');
  });

  it('keeps the trash folder unreachable', async () => {
    await fx.file('public/.wfb-trash/lz1abcde-0011aabb/item', 'trashed');
    for (const p of ['/.wfb-trash', '/.WFB-TRASH/lz1abcde-0011aabb/item', '/.wfb-trash/../a.txt']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/files/download',
        query: { share: 'public', path: p },
      });
      expect([400, 404]).toContain(res.statusCode);
    }
    const del = await app.inject({
      method: 'POST',
      url: '/api/files/delete',
      payload: { items: [{ share: 'public', path: '/.wfb-trash' }], permanent: true },
    });
    expect(del.statusCode).toBe(403);
  });
});

describe('symlink escapes', () => {
  let fx: Fixture;
  let app: FastifyInstance;
  let outside: string;

  beforeEach(async () => {
    fx = await createFixture({
      yamlExtra: `
  - id: team
    name: Equipo
    path: HOMES/../team
    visibility: private
    acl:
      - user: alice
        permissions: [read, write, delete]
`,
    });
    outside = path.join(fx.tmp, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'TOPSECRET');
    await writeFile(path.join(outside, 'secret.png'), 'TOPSECRET');
    await fx.dir('team');
    await fx.file('public/a.txt', 'public');
    await fx.file('eng/design.txt', 'eng only');
    const pub = path.join(fx.root, 'public');
    await symlink(outside, path.join(pub, 'outdir'));
    await symlink(path.join(outside, 'secret.txt'), path.join(pub, 'leak.txt'));
    await symlink(path.join(outside, 'secret.png'), path.join(pub, 'leak.png'));
    await symlink(path.join(fx.root, 'eng'), path.join(pub, 'toeng'));
    await symlink(path.join(fx.tmp, 'nowhere'), path.join(pub, 'dangling'));
    await symlink('../../outside', path.join(fx.root, 'team', 'relative'));
    app = await fx.app(users.alice);
  });
  afterEach(() => fx.cleanup());

  const get = (url: string, query: Record<string, string>) => app.inject({ method: 'GET', url, query });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

  it('omits escaping and dangling links from listings and search', async () => {
    const list = await get('/api/files', { share: 'public', path: '/' });
    expect(list.json().entries.map((e: { name: string }) => e.name)).toEqual(['a.txt']);
    const search = await get('/api/search', { share: 'public', path: '/', q: 'e' });
    expect(search.json().results).toEqual([]);
  });

  it('refuses to read through file and directory links (incl. into another share)', async () => {
    const reads: [string, Record<string, string>][] = [
      ['/api/files/download', { share: 'public', path: '/leak.txt' }],
      ['/api/files/stat', { share: 'public', path: '/leak.txt' }],
      ['/api/files', { share: 'public', path: '/outdir' }],
      ['/api/files/download', { share: 'public', path: '/outdir/secret.txt' }],
      ['/api/files/download', { share: 'public', path: '/toeng/design.txt' }],
      ['/api/files', { share: 'team', path: '/relative' }],
      ['/api/preview/info', { share: 'public', path: '/leak.txt' }],
      ['/api/preview/content', { share: 'public', path: '/leak.txt' }],
      ['/api/preview/thumbnail', { share: 'public', path: '/leak.png' }],
      ['/api/search', { share: 'public', path: '/outdir', q: 'secret' }],
    ];
    for (const [url, query] of reads) {
      const res = await get(url, query);
      expect(res.statusCode, `${url} ${query.path}`).toBe(403);
      expect(res.body).not.toContain('TOPSECRET');
    }
    expect((await get('/api/files', { share: 'public', path: '/dangling' })).statusCode).toBe(404);
  });

  it('refuses writes whose destination goes through a link', async () => {
    const upload = multipart([{ name: 'x.txt', content: 'x' }]);
    const attempts = [
      () => post('/api/files/mkdir', { share: 'public', path: '/outdir', name: 'x' }),
      () => post('/api/files/mkdir', { share: 'public', path: '/toeng', name: 'x' }),
      () => post('/api/files/rename', { share: 'public', path: '/outdir/secret.txt', newName: 'x' }),
      () => post('/api/files/copy', { items: [ref], destination: { share: 'public', path: '/outdir' } }),
      () => post('/api/files/copy', { items: [ref], destination: { share: 'public', path: '/toeng' } }),
      () => post('/api/files/copy', { items: [ref], destination: { share: 'team', path: '/relative' } }),
      () =>
        post('/api/files/copy', {
          items: [{ share: 'public', path: '/outdir' }],
          destination: { share: 'team', path: '/' },
        }),
      () =>
        post('/api/files/move', {
          items: [{ share: 'team', path: '/relative/secret.txt' }],
          destination: { share: 'team', path: '/' },
        }),
      () =>
        post('/api/files/delete', {
          items: [{ share: 'public', path: '/outdir/secret.txt' }],
          permanent: true,
        }),
      () => post('/api/uploads', { share: 'public', path: '/outdir', name: 'x.txt', size: 1 }),
      () =>
        app.inject({
          method: 'POST',
          url: '/api/files/upload?share=public&path=/outdir',
          payload: upload.payload,
          headers: upload.headers,
        }),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.statusCode).toBe(403);
    }
    expect((await readdir(outside)).sort()).toEqual(['secret.png', 'secret.txt']);
    expect(await readdir(path.join(fx.root, 'eng'))).toEqual(['design.txt']);
    expect((await readdir(path.join(fx.root, 'team'))).sort()).toEqual(['relative']);
  });

  it('dangling links cannot be used to create entries outside the share', async () => {
    expect(
      (await post('/api/files/mkdir', { share: 'public', path: '/dangling', name: 'x' })).statusCode,
    ).toBe(404);
    const { payload, headers } = multipart([{ name: 'x', content: 'x' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/upload?share=public&path=/dangling',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(404);
    await expect(lstat(path.join(fx.tmp, 'nowhere'))).rejects.toThrow();
  });

  it('overwriting or deleting a link replaces/removes the link, never its target', async () => {
    const { payload, headers } = multipart([
      { name: 'leak.txt', content: 'overwritten' },
      { name: 'dangling', content: 'overwritten' },
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/files/upload?share=public&path=/&conflict=overwrite',
      payload,
      headers,
    });
    expect(up.statusCode).toBe(200);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOPSECRET');
    expect((await lstat(path.join(fx.root, 'public/leak.txt'))).isSymbolicLink()).toBe(false);
    await expect(lstat(path.join(fx.tmp, 'nowhere'))).rejects.toThrow();

    // team: alice has delete. Escaping links cannot even be deleted through the API.
    await symlink(outside, path.join(fx.root, 'team', 'outdir'));
    await symlink(path.join(fx.root, 'eng'), path.join(fx.root, 'team', 'toeng'));
    for (const p of ['/outdir', '/toeng']) {
      for (const permanent of [true, false]) {
        const del = await post('/api/files/delete', { items: [{ share: 'team', path: p }], permanent });
        expect(del.statusCode).toBe(403);
      }
    }
    expect((await readdir(outside)).sort()).toEqual(['secret.png', 'secret.txt']);
    expect(await readdir(path.join(fx.root, 'eng'))).toEqual(['design.txt']);

    // A link inside the share is removed itself, never its target.
    await fx.file('team/real/keep.txt', 'keep');
    await symlink(path.join(fx.root, 'team', 'real'), path.join(fx.root, 'team', 'inner'));
    const del = await post('/api/files/delete', {
      items: [{ share: 'team', path: '/inner' }],
      permanent: true,
    });
    expect(del.json().results[0].status).toBe('deleted');
    expect(await readFile(path.join(fx.root, 'team/real/keep.txt'), 'utf8')).toBe('keep');
  });
});
