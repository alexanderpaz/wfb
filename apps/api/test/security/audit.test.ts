import type { PrismaClient } from '@prisma/client';
import { CSRF_HEADER, SESSION_COOKIE, type User } from '@wfb/contracts';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AuditService } from '../../src/audit/index.js';
import { MemoryStore } from '../../src/lib/kv.js';
import { FakeDirectory, sampleDirectory } from '../auth/fake-ldap.js';
import { createFixture, multipart, users, type Fixture } from '../files/fixture.js';
import { testConfig } from '../helpers.js';

const fake = vi.hoisted(() => ({ dir: null as FakeDirectory | null }));

vi.mock('ldapts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ldapts')>();
  return {
    ...actual,
    Client: class {
      constructor() {
        return fake.dir!.factory();
      }
    },
  };
});

type Row = Record<string, unknown>;

function fakePrisma(opts: { failWrites?: boolean } = {}) {
  const rows: Row[] = [];
  const prisma = {
    rows,
    failWrites: opts.failWrites ?? false,
    auditLog: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (prisma.failWrites) throw new Error('database is down');
        rows.push(data);
        return data;
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { username: string } }) => ({
        id: `row-${where.username}`,
      })),
      upsert: vi.fn(async () => ({})),
    },
    $disconnect: vi.fn(async () => {}),
  };
  return prisma;
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

/** onResponse hooks run after inject() resolves: let them fire, then wait for the writes. */
async function settle(app: FastifyInstance) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await app.audit.flush();
}

describe('AuditService', () => {
  const event = {
    action: 'mkdir' as const,
    user: users.alice,
    share: 'public',
    path: '/a',
    outcome: 'success' as const,
    ip: '10.0.0.1',
  };

  it('writes AuditLog rows linked to the persisted user', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as unknown as PrismaClient, fakeLog());
    await audit.record({ ...event, target: 'x', detail: { a: 1 } });
    await audit.record(event);
    expect(prisma.rows[0]).toEqual({
      userId: 'row-alice',
      username: 'alice',
      action: 'mkdir',
      share: 'public',
      path: '/a',
      target: 'x',
      success: true,
      ip: '10.0.0.1',
      details: { a: 1 },
    });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it('records anonymous failures with the attempted username', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as unknown as PrismaClient, fakeLog());
    await audit.record({ action: 'login', user: null, username: 'mallory', outcome: 'failure' });
    expect(prisma.rows[0]).toMatchObject({ userId: null, username: 'mallory', success: false });
  });

  it('never throws when the database write fails, and logs a warning', async () => {
    const prisma = fakePrisma({ failWrites: true });
    const log = fakeLog();
    const audit = new AuditService(prisma as unknown as PrismaClient, log);
    await expect(audit.record(event)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ audit: expect.objectContaining({ action: 'mkdir' }) }),
      'could not write audit log',
    );
  });

  it('keeps the event when the user lookup fails', async () => {
    const prisma = fakePrisma();
    prisma.user.findFirst.mockRejectedValueOnce(new Error('boom'));
    const audit = new AuditService(prisma as unknown as PrismaClient, fakeLog());
    await audit.record(event);
    expect(prisma.rows[0]).toMatchObject({ userId: null, username: 'alice' });
  });

  it('only logs when Postgres is not configured', async () => {
    const log = fakeLog();
    const audit = new AuditService(null, log);
    await audit.record(event);
    expect(log.info).toHaveBeenCalledWith(
      { audit: expect.objectContaining({ action: 'mkdir', username: 'alice', outcome: 'success' }) },
      'audit',
    );
  });
});

describe('audited file operations', () => {
  let fx: Fixture;
  let prisma: ReturnType<typeof fakePrisma>;
  let app: FastifyInstance;

  const HOME = 'home:\n  enabled: true\n  root: HOMES\n  permissions: [read, write, delete]\n';

  async function appAs(user: User) {
    const config = testConfig({ SHARES_CONFIG: fx.yamlPath, DATA_DIR: path.join(fx.tmp, 'data') });
    app = await buildApp({
      config,
      services: { kv: new MemoryStore(), prisma: prisma as unknown as PrismaClient },
      testUser: user,
    });
    return app;
  }
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const events = async () => {
    await settle(app);
    return prisma.rows.splice(0);
  };

  beforeEach(async () => {
    fx = await createFixture({ yamlExtra: HOME });
    prisma = fakePrisma();
    await appAs(users.alice);
  });
  afterEach(async () => {
    await app.close();
    await fx.cleanup();
  });

  it('records mkdir, rename, copy, move and delete with their targets', async () => {
    await fx.file('homes/alice/a.txt', 'abc');
    expect((await post('/api/files/mkdir', { share: 'home', path: '/', name: 'docs' })).statusCode).toBe(200);
    expect(await events()).toEqual([
      expect.objectContaining({
        action: 'mkdir',
        username: 'alice',
        share: 'home',
        path: '/docs',
        success: true,
      }),
    ]);

    await post('/api/files/rename', { share: 'home', path: '/a.txt', newName: 'b.txt' });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'rename', path: '/a.txt', target: '/b.txt', success: true }),
    ]);

    await post('/api/files/copy', {
      items: [{ share: 'home', path: '/b.txt' }],
      destination: { share: 'public', path: '/' },
    });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'copy', share: 'home', path: '/b.txt', target: 'public:/b.txt' }),
    ]);

    await post('/api/files/move', {
      items: [{ share: 'home', path: '/b.txt' }],
      destination: { share: 'home', path: '/docs' },
    });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'move', path: '/b.txt', target: 'home:/docs/b.txt', success: true }),
    ]);

    await post('/api/files/delete', { items: [{ share: 'home', path: '/docs/b.txt' }] });
    expect(await events()).toEqual([
      expect.objectContaining({
        action: 'delete',
        path: '/docs/b.txt',
        success: true,
        details: expect.objectContaining({ status: 'trashed', permanent: false }),
      }),
    ]);
  });

  it('records denied operations as failures', async () => {
    const res = await post('/api/files/mkdir', { share: 'finance', path: '/', name: 'x' });
    expect(res.statusCode).toBe(403);
    expect(await events()).toEqual([
      expect.objectContaining({
        action: 'mkdir',
        share: 'finance',
        path: '/x',
        success: false,
        details: expect.objectContaining({ status: 403, error: 'FORBIDDEN' }),
      }),
    ]);

    await post('/api/files/delete', { items: [{ share: 'eng', path: '/secret' }] });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'delete', share: 'eng', success: false }),
    ]);
  });

  it('records multipart and resumable uploads', async () => {
    const { payload, headers } = multipart([{ name: 'a.txt', content: 'hi' }]);
    await app.inject({ method: 'POST', url: '/api/files/upload?share=home&path=/', payload, headers });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'upload', share: 'home', path: '/a.txt', success: true }),
    ]);

    const created = await post('/api/uploads', { share: 'home', path: '/', name: 'big.bin', size: 3 });
    const { id } = created.json();
    await app.inject({
      method: 'PUT',
      url: `/api/uploads/${id}?offset=0`,
      payload: Buffer.from('abc'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(await events()).toEqual([]);
    await post(`/api/uploads/${id}/complete`, {});
    expect(await events()).toEqual([
      expect.objectContaining({
        action: 'upload',
        share: 'home',
        path: '/big.bin',
        success: true,
        details: { resumable: true, size: 3 },
      }),
    ]);
  });

  it('records trash restore and purge per item', async () => {
    await fx.file('homes/alice/a.txt');
    await fx.file('homes/alice/b.txt');
    await post('/api/files/delete', {
      items: [
        { share: 'home', path: '/a.txt' },
        { share: 'home', path: '/b.txt' },
      ],
    });
    await events();
    const items = (await app.inject({ method: 'GET', url: '/api/trash?share=home' })).json().items as {
      id: string;
      name: string;
    }[];
    const a = items.find((i) => i.name === 'a.txt')!;
    const b = items.find((i) => i.name === 'b.txt')!;

    await post('/api/trash/restore', { share: 'home', ids: [a.id] });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'trash.restore', share: 'home', path: '/a.txt', success: true }),
    ]);
    await post('/api/trash/purge', { share: 'home', ids: [b.id] });
    expect(await events()).toEqual([
      expect.objectContaining({ action: 'trash.purge', share: 'home', path: '/b.txt', success: true }),
    ]);
  });

  it('does not record reads', async () => {
    await fx.file('public/r.txt');
    await app.inject({ method: 'GET', url: '/api/files?share=public&path=/' });
    await app.inject({ method: 'GET', url: '/api/files/download?share=public&path=/r.txt' });
    expect(await events()).toEqual([]);
  });

  it('never fails the request when the audit write fails', async () => {
    prisma.failWrites = true;
    const res = await post('/api/files/mkdir', { share: 'home', path: '/', name: 'still-works' });
    expect(res.statusCode).toBe(200);
    await settle(app);
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('records copy/move jobs when they finish', async () => {
    await app.close();
    const config = testConfig({
      SHARES_CONFIG: fx.yamlPath,
      DATA_DIR: path.join(fx.tmp, 'data'),
      SYNC_TRANSFER_LIMIT_MB: '0',
    });
    app = await buildApp({
      config,
      services: { kv: new MemoryStore(), prisma: prisma as unknown as PrismaClient },
      testUser: users.alice,
    });
    await fx.file('homes/alice/big.txt', 'x'.repeat(1024));
    const res = await post('/api/files/copy', {
      items: [{ share: 'home', path: '/big.txt' }],
      destination: { share: 'public', path: '/' },
    });
    expect(res.json().mode).toBe('job');
    await vi.waitFor(async () => {
      await app.audit.flush();
      expect(prisma.rows).toEqual([
        expect.objectContaining({
          action: 'copy',
          path: '/big.txt',
          target: 'public:/big.txt',
          success: true,
          details: expect.objectContaining({ mode: 'job' }),
        }),
      ]);
    });
  });
});

describe('audited authentication', () => {
  const ENV = {
    DIRECTORY_KIND: 'ldap',
    LDAP_URL: 'ldap://fake:389',
    LDAP_BASE_DN: 'dc=example,dc=org',
    LDAP_BIND_DN: 'cn=readonly,dc=example,dc=org',
    LDAP_BIND_PASSWORD: 'readonly',
  };
  let app: FastifyInstance;
  let prisma: ReturnType<typeof fakePrisma>;

  beforeEach(async () => {
    fake.dir = sampleDirectory();
    prisma = fakePrisma();
    app = await buildApp({
      config: testConfig(ENV),
      services: { kv: new MemoryStore(), prisma: prisma as unknown as PrismaClient },
    });
  });
  afterEach(async () => app.close());

  const login = (username: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/ldap/login', payload: { username, password } });

  it('records login failures, successes and logout', async () => {
    expect((await login('alice', 'wrong')).statusCode).toBe(401);
    const ok = await login('alice', 'alice123');
    const cookie = ok.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: ok.json().csrfToken },
    });
    await settle(app);
    expect(prisma.rows).toEqual([
      expect.objectContaining({
        action: 'login',
        username: 'alice',
        userId: null,
        success: false,
        details: { provider: 'ldap', status: 401, error: 'UNAUTHENTICATED' },
      }),
      expect.objectContaining({ action: 'login', username: 'alice', userId: 'row-alice', success: true }),
      expect.objectContaining({ action: 'logout', username: 'alice', success: true }),
    ]);
  });

  it('records rate-limited logins', async () => {
    for (let i = 0; i < 11; i++) await login('bob', 'nope');
    await settle(app);
    expect(prisma.rows.at(-1)).toMatchObject({
      action: 'login',
      username: 'bob',
      success: false,
      details: { status: 429, error: 'RATE_LIMITED' },
    });
  });
});
