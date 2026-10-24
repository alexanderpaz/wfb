import type { PrismaClient } from '@prisma/client';
import { CSRF_HEADER, LogoutResponse, SESSION_COOKIE } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { MemoryStore } from '../../src/lib/kv.js';
import { MockIdp } from '../auth/mock-idp.js';
import { testConfig } from '../helpers.js';

const APP_URL = 'http://localhost:5173';
const claims = { sub: 'd1', preferred_username: 'dana', email: 'dana@example.org', groups: ['staff'] };

let idp: MockIdp;
let app: FastifyInstance;
let kv: MemoryStore;
let rows: Record<string, unknown>[];

beforeAll(async () => {
  idp = await new MockIdp().start();
});
afterAll(async () => idp.stop());

async function createApp() {
  kv = new MemoryStore();
  rows = [];
  const prisma = {
    auditLog: { create: vi.fn(async ({ data }) => rows.push(data)) },
    user: { findFirst: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    $disconnect: vi.fn(async () => {}),
  };
  app = await buildApp({
    config: testConfig({
      APP_URL,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'wfb',
      OIDC_CLIENT_SECRET: 's3cret',
    }),
    services: { kv, prisma: prisma as unknown as PrismaClient },
  });
}

async function oidcLogin() {
  const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
  const location = start.headers.location as string;
  const stateCookie = start.cookies.find((c) => c.name === 'wfb_oidc')!.value;
  const code = idp.authorize(location, claims);
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/oidc/callback',
    query: { code, state: new URL(location).searchParams.get('state')! },
    headers: { cookie: `wfb_oidc=${stateCookie}` },
  });
  expect(res.statusCode).toBe(302);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const me = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  return { cookie, csrf: me.json().csrfToken as string };
}

const logout = (cookie: string, csrf: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf },
  });

beforeEach(async () => {
  idp.endSession = true;
  idp.idTokens = [];
  idp.failDiscovery = 0;
  await createApp();
});
afterEach(async () => app?.close());

describe('OIDC RP-initiated logout', () => {
  it('keeps the id token in the server-side session', async () => {
    const { cookie } = await oidcLogin();
    const id = app.unsignCookie(cookie).value!;
    const session = JSON.parse((await kv.get(`sess:${id}`))!);
    expect(session.idToken).toBe(idp.idTokens[0]);
  });

  it('returns the IdP end-session URL with id_token_hint and post_logout_redirect_uri', async () => {
    const { cookie, csrf } = await oidcLogin();
    const res = await logout(cookie, csrf);
    expect(res.statusCode).toBe(200);
    const body = LogoutResponse.parse(res.json());
    const url = new URL(body.redirectUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}end-session/`);
    expect(url.searchParams.get('id_token_hint')).toBe(idp.idTokens[0]);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(APP_URL);
    expect(url.searchParams.get('client_id')).toBe('wfb');

    // The local session is gone regardless of the IdP.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(me.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)!.value).toBe('');
  });

  it('only destroys the local session when the IdP has no end_session_endpoint', async () => {
    await app.close();
    idp.endSession = false;
    await createApp();
    const { cookie, csrf } = await oidcLogin();
    const res = await logout(cookie, csrf);
    expect(res.json()).toEqual({ ok: true });
  });

  it('still logs out locally when the IdP is unreachable at logout time', async () => {
    // A fresh app has not run discovery yet; every attempt now fails.
    const user = { id: 'oidc:dana', username: 'dana', displayName: 'Dana', email: null, groups: [] };
    await kv.set(
      'sess:oidc-session-id-0123456789',
      JSON.stringify({ user: { ...user, provider: 'oidc' }, csrfToken: 'csrf-token', idToken: 'x.y.z' }),
    );
    idp.failDiscovery = 5;
    const res = await logout(app.signCookie('oidc-session-id-0123456789'), 'csrf-token');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await kv.get('sess:oidc-session-id-0123456789')).toBeNull();
  });

  it('audits OIDC logins and logouts', async () => {
    const failed = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback',
      query: { code: 'x', state: 'forged' },
    });
    expect(failed.headers.location).toBe('/?authError=oidc_state');
    const { cookie, csrf } = await oidcLogin();
    await logout(cookie, csrf);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.audit.flush();
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'login',
        success: false,
        details: { provider: 'oidc', error: 'oidc_state' },
      }),
      expect.objectContaining({ action: 'login', username: 'dana', success: true }),
      expect.objectContaining({ action: 'logout', username: 'dana', success: true }),
    ]);
  });
});
