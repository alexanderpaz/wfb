import { CSRF_HEADER, MeResponse, SESSION_COOKIE } from '@wfb/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { requireUser } from '../../src/lib/auth-context.js';
import { MemoryStore } from '../../src/lib/kv.js';
import { testConfig } from '../helpers.js';
import { FakeDirectory, sampleDirectory } from './fake-ldap.js';

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

const LDAP_ENV = {
  DIRECTORY_KIND: 'ldap',
  LDAP_URL: 'ldap://fake:389',
  LDAP_BASE_DN: 'dc=example,dc=org',
  LDAP_BIND_DN: 'cn=readonly,dc=example,dc=org',
  LDAP_BIND_PASSWORD: 'readonly',
};

let app: FastifyInstance;
let kv: MemoryStore;

async function createApp(env: Record<string, string> = LDAP_ENV) {
  kv = new MemoryStore();
  app = await buildApp({ config: testConfig(env), services: { kv, prisma: null } });
  app.post('/api/test/echo', async (request) => ({ user: requireUser(request).username }));
  return app;
}

function sessionCookie(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE);
}

async function login(username = 'alice', password = 'alice123', cookie?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/ldap/login',
    payload: { username, password },
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
  return { res, cookie: sessionCookie(res)?.value, body: res.json() };
}

const withSession = (cookie: string, csrf?: string) => ({
  cookie: `${SESSION_COOKIE}=${cookie}`,
  ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
});

beforeEach(() => {
  fake.dir = sampleDirectory();
});
afterEach(async () => app?.close());

describe('GET /api/auth/providers', () => {
  it('reports nothing when no provider is configured', async () => {
    await createApp({});
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(res.json()).toEqual({ directory: null, oidc: null });
  });

  it('reports directory and oidc providers', async () => {
    await createApp({
      ...LDAP_ENV,
      DIRECTORY_KIND: 'ad',
      DIRECTORY_LABEL: 'Cuenta corporativa',
      OIDC_ISSUER: 'https://auth.example.org/application/o/wfb/',
      OIDC_CLIENT_ID: 'wfb',
    });
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(res.json()).toEqual({
      directory: { kind: 'ad', label: 'Cuenta corporativa' },
      oidc: { label: 'Authentik', loginUrl: '/api/auth/oidc/login' },
    });
  });
});

describe('POST /api/auth/ldap/login', () => {
  beforeEach(async () => {
    await createApp();
  });

  it('logs in and sets a hardened session cookie', async () => {
    const { res, body } = await login();
    expect(res.statusCode).toBe(200);
    const me = MeResponse.parse(body);
    expect(me.user).toMatchObject({ id: 'ldap:alice', username: 'alice', groups: ['engineering', 'staff'] });
    expect(me.csrfToken.length).toBeGreaterThan(20);

    const cookie = sessionCookie(res)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeFalsy();
    expect(cookie.maxAge).toBe(12 * 3600);
    // signed cookie: "<id>.<signature>", the raw id is what is stored in kv
    const id = app.unsignCookie(cookie.value);
    expect(id.valid).toBe(true);
    expect(await kv.get(`sess:${id.value}`)).toContain('"username":"alice"');
  });

  it('marks the cookie secure for https deployments', async () => {
    await app.close();
    await createApp({ ...LDAP_ENV, APP_URL: 'https://files.example.org' });
    const { res } = await login();
    expect(sessionCookie(res)?.secure).toBe(true);
  });

  it('rejects a wrong password with a generic message', async () => {
    const { res, body, cookie } = await login('alice', 'wrong');
    expect(res.statusCode).toBe(401);
    expect(body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Usuario o contraseña incorrectos' } });
    expect(cookie).toBeUndefined();
  });

  it('rejects unknown users with the same message', async () => {
    const { res, body } = await login('mallory', 'whatever');
    expect(res.statusCode).toBe(401);
    expect(body.error.message).toBe('Usuario o contraseña incorrectos');
  });

  it('is not vulnerable to LDAP filter injection', async () => {
    const { res } = await login('*', 'alice123');
    expect(res.statusCode).toBe(401);
    expect(fake.dir!.filters()).toEqual(['(uid=\\2a)']);
  });

  it('validates the body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/ldap/login', payload: { username: 'a' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('returns 500 with a clear message when the directory is down', async () => {
    fake.dir!.unavailable = true;
    const { res, body } = await login();
    expect(res.statusCode).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL', message: 'El servicio de directorio no está disponible' });
  });

  it('rotates the session id and csrf token on login (fixation)', async () => {
    const first = await login();
    const firstId = app.unsignCookie(first.cookie!).value!;
    const second = await login('carol', 'carol123', first.cookie);
    const secondId = app.unsignCookie(second.cookie!).value!;
    expect(secondId).not.toBe(firstId);
    expect(second.body.csrfToken).not.toBe(first.body.csrfToken);
    expect(await kv.get(`sess:${firstId}`)).toBeNull();
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withSession(first.cookie!) });
    expect(me.statusCode).toBe(401);
  });

  it('ignores attacker-chosen unsigned session ids', async () => {
    await kv.set('sess:attacker-chosen-session-id-123', JSON.stringify({ user: {}, csrfToken: 'x' }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=attacker-chosen-session-id-123` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rate limits per username', async () => {
    const limit = 10;
    for (let i = 0; i < limit; i++) {
      expect((await login('alice', 'wrong')).res.statusCode).toBe(401);
    }
    const blocked = await login('alice', 'alice123');
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(await kv.get('rl:login-user:alice')).toBe(String(limit + 1));
  });

  it('rate limits per client ip', async () => {
    await app.close();
    await createApp({ ...LDAP_ENV, LOGIN_RATE_LIMIT_PER_MINUTE: '3' });
    for (const u of ['u1', 'u2', 'u3']) expect((await login(u, 'x')).res.statusCode).toBe(401);
    expect((await login('alice', 'alice123')).res.statusCode).toBe(429);
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/ldap/login',
      payload: { username: 'carol', password: 'carol123' },
      remoteAddress: '10.0.0.9',
    });
    expect(other.statusCode).toBe(200);
  });

  it('is 404 when no directory is configured', async () => {
    await app.close();
    await createApp({});
    expect((await login()).res.statusCode).toBe(404);
  });
});

describe('session routes and CSRF', () => {
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    await createApp();
    const result = await login();
    cookie = result.cookie!;
    csrf = result.body.csrfToken;
  });

  it('GET /api/auth/me returns the session user and csrf token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withSession(cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: expect.objectContaining({ username: 'alice' }),
      csrfToken: csrf,
    });
  });

  it('GET /api/auth/me is 401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects tampered cookies', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withSession(`${cookie}x`) });
    expect(res.statusCode).toBe(401);
  });

  it('requires the csrf header on mutating requests', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/test/echo', headers: withSession(cookie) });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('CSRF');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: withSession(cookie, `${csrf.slice(0, -1)}A`),
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await app.inject({ method: 'POST', url: '/api/test/echo', headers: withSession(cookie, csrf) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ user: 'alice' });
  });

  it('yields 401 (not 403) for mutating requests without a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { [CSRF_HEADER]: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('logout requires csrf, destroys the session and clears the cookie', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: withSession(cookie) });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: withSession(cookie, csrf) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cleared = sessionCookie(res)!;
    expect(cleared.value).toBe('');
    expect(new Date(cleared.expires!).getTime()).toBeLessThan(Date.now());

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withSession(cookie) });
    expect(me.statusCode).toBe(401);
  });

  it('logout without a session is 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(401);
  });

  it('expires sessions with the configured TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 12 * 3600 * 1000 + 1000);
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withSession(cookie) });
      expect(res.statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
