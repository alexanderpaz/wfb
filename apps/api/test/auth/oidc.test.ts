import { SESSION_COOKIE } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupsFromClaim, safeReturnTo, userFromClaims } from '../../src/auth/oidc.js';
import { buildApp } from '../../src/app.js';
import { MemoryStore } from '../../src/lib/kv.js';
import { testConfig } from '../helpers.js';
import { MockIdp } from './mock-idp.js';

const APP_URL = 'http://localhost:5173';
const REDIRECT_URI = `${APP_URL}/api/auth/oidc/callback`;

const claims = {
  sub: 'a1b2c3',
  preferred_username: 'Dana',
  email: 'dana@example.org',
  name: 'Dana Scully',
  groups: ['finance', 'staff'],
};

let idp: MockIdp;
let app: FastifyInstance;
let kv: MemoryStore;

beforeAll(async () => {
  idp = await new MockIdp().start();
});
afterAll(async () => idp.stop());

async function createApp(env: Record<string, string> = {}) {
  kv = new MemoryStore();
  app = await buildApp({
    config: testConfig({
      APP_URL,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'wfb',
      OIDC_CLIENT_SECRET: 's3cret',
      ...env,
    }),
    services: { kv, prisma: null },
  });
  return app;
}

async function startLogin(returnTo?: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/oidc/login',
    query: returnTo === undefined ? {} : { returnTo },
  });
  expect(res.statusCode).toBe(302);
  return res.headers.location as string;
}

async function callback(query: Record<string, string>) {
  return app.inject({ method: 'GET', url: '/api/auth/oidc/callback', query });
}

async function fullLogin(returnTo?: string, userClaims: Record<string, unknown> = claims) {
  const location = await startLogin(returnTo);
  const state = new URL(location).searchParams.get('state')!;
  const code = idp.authorize(location, userClaims);
  return { res: await callback({ code, state }), state, code };
}

beforeEach(async () => {
  idp.clientSecret = 's3cret';
  idp.userinfo = {};
  idp.tokenRequests = [];
  idp.failDiscovery = 0;
  await createApp();
});
afterEach(async () => app?.close());

describe('GET /api/auth/oidc/login', () => {
  it('redirects to the IdP with PKCE S256, state and nonce', async () => {
    const location = new URL(await startLogin('/shares/docs'));
    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer}authorize/`);
    const p = location.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('wfb');
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('scope')).toBe('openid profile email groups');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(p.get('state')).toBeTruthy();
    expect(p.get('nonce')).toBeTruthy();

    const pending = JSON.parse((await kv.get(`oidc:${p.get('state')}`))!);
    expect(pending).toMatchObject({ returnTo: '/shares/docs', nonce: p.get('nonce') });
    expect(pending.codeVerifier).toBeTruthy();
  });

  it('uses a fresh state for every login', async () => {
    const a = new URL(await startLogin()).searchParams.get('state');
    const b = new URL(await startLogin()).searchParams.get('state');
    expect(a).not.toBe(b);
  });

  it.each(['//evil.example', 'https://evil.example/x', '/\\evil.example', 'evil', '/%0d%0aSet-Cookie:x', ''])(
    'rejects open redirect target %j',
    async (target) => {
      const state = new URL(await startLogin(target)).searchParams.get('state');
      const pending = JSON.parse((await kv.get(`oidc:${state}`))!);
      expect(pending.returnTo).not.toMatch(/evil/);
      expect(pending.returnTo.startsWith('/')).toBe(true);
      expect(pending.returnTo.startsWith('//')).toBe(false);
    },
  );

  it('retries discovery after a failure', async () => {
    idp.failDiscovery = 1;
    const before = idp.discoveryRequests;
    const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?authError=oidc_unavailable');
    const location = await startLogin();
    expect(location.startsWith(idp.issuer)).toBe(true);
    await startLogin();
    expect(idp.discoveryRequests - before).toBe(2);
  });

  it('is 404 when OIDC is not configured', async () => {
    await app.close();
    app = await buildApp({ config: testConfig(), services: { kv: new MemoryStore(), prisma: null } });
    const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/auth/oidc/callback', () => {
  it('completes the login, sets the session and redirects to returnTo', async () => {
    idp.userinfo = { name: 'Dana K. Scully' };
    const { res } = await fullLogin('/shares/finance?view=list');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/shares/finance?view=list');

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toEqual({
      id: 'oidc:dana',
      username: 'dana',
      displayName: 'Dana K. Scully',
      email: 'dana@example.org',
      groups: ['finance', 'staff'],
      provider: 'oidc',
    });

    const tokenRequest = idp.tokenRequests[0]!;
    expect(tokenRequest.auth).toBeUndefined();
    expect(tokenRequest.params.get('client_secret')).toBe(idp.clientSecret);
    expect(tokenRequest.params.get('code_verifier')).toBeTruthy();
  });

  it('uses client_secret_basic when configured', async () => {
    await app.close();
    await createApp({ OIDC_TOKEN_AUTH_METHOD: 'client_secret_basic' });
    const { res } = await fullLogin('/');
    expect(res.statusCode).toBe(302);
    expect(idp.tokenRequests[0]!.auth).toMatch(/^Basic /);
    expect(idp.tokenRequests[0]!.params.get('client_secret')).toBeNull();
  });

  it('works as a public client without secret', async () => {
    await app.close();
    idp.clientSecret = undefined;
    await createApp({ OIDC_CLIENT_SECRET: '' });
    const { res } = await fullLogin('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(idp.tokenRequests[0]!.auth).toBeUndefined();
    expect(idp.tokenRequests[0]!.params.get('client_id')).toBe('wfb');
  });

  it('redirects to / when returnTo was an open redirect', async () => {
    const { res } = await fullLogin('//evil.example/phish');
    expect(res.headers.location).toBe('/');
  });

  it('state is single use', async () => {
    const { state, res } = await fullLogin();
    expect(res.statusCode).toBe(302);
    expect(await kv.get(`oidc:${state}`)).toBeNull();
    const replay = await callback({ code: 'whatever', state });
    expect(replay.headers.location).toBe('/?authError=oidc_state');
    expect(replay.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects unknown state', async () => {
    const res = await callback({ code: 'x', state: 'forged' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?authError=oidc_state');
  });

  it('reports IdP errors (user denied consent)', async () => {
    const state = new URL(await startLogin()).searchParams.get('state')!;
    const res = await callback({ error: 'access_denied', state });
    expect(res.headers.location).toBe('/?authError=oidc_denied');
  });

  it('fails when the code exchange is rejected', async () => {
    const state = new URL(await startLogin()).searchParams.get('state')!;
    const res = await callback({ code: 'not-issued', state });
    expect(res.headers.location).toBe('/?authError=oidc_failed');
  });

  it('fails when the code was issued for another login (PKCE / nonce mismatch)', async () => {
    const first = await startLogin();
    const second = await startLogin();
    const code = idp.authorize(first, claims);
    const res = await callback({ code, state: new URL(second).searchParams.get('state')! });
    expect(res.headers.location).toBe('/?authError=oidc_failed');
  });

  it('rotates an existing session', async () => {
    const a = (await fullLogin()).res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const location = await startLogin();
    const code = idp.authorize(location, claims);
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback',
      query: { code, state: new URL(location).searchParams.get('state')! },
      headers: { cookie: `${SESSION_COOKIE}=${a}` },
    });
    const b = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    expect(b).not.toBe(a);
    const old = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${a}` },
    });
    expect(old.statusCode).toBe(401);
  });
});

describe('OIDC helpers', () => {
  it.each([
    ['/', '/'],
    ['/shares/a b?x=1#h', '/shares/a%20b?x=1#h'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['relative/path', '/'],
    [undefined, '/'],
    [['/a'], '/'],
  ])('safeReturnTo(%j) = %j', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it('accepts groups as array or string', () => {
    expect(groupsFromClaim(['b', 'a', 'a', 3])).toEqual(['a', 'b']);
    expect(groupsFromClaim('admins')).toEqual(['admins']);
    expect(groupsFromClaim(undefined)).toEqual([]);
  });

  it('derives the username from preferred_username, email or sub', () => {
    expect(userFromClaims({ sub: 'S1', email: 'X@y.org' }, 'groups').username).toBe('x@y.org');
    expect(userFromClaims({ sub: 'S1' }, 'groups')).toMatchObject({
      username: 's1',
      email: null,
      groups: [],
    });
    expect(userFromClaims({ sub: 's', preferred_username: 'u', roles: ['r'] }, 'roles').groups).toEqual([
      'r',
    ]);
  });
});
