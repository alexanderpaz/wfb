import { CSRF_HEADER, SESSION_COOKIE } from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { MemoryStore } from '../../src/lib/kv.js';
import { FakeDirectory, sampleDirectory } from '../auth/fake-ldap.js';
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

const APP_URL = 'https://files.example.org';
const ENV = {
  APP_URL,
  DIRECTORY_KIND: 'ldap',
  LDAP_URL: 'ldap://fake:389',
  LDAP_BASE_DN: 'dc=example,dc=org',
  LDAP_BIND_DN: 'cn=readonly,dc=example,dc=org',
  LDAP_BIND_PASSWORD: 'readonly',
};

let app: FastifyInstance;

beforeEach(async () => {
  fake.dir = sampleDirectory();
  app = await buildApp({ config: testConfig(ENV), services: { kv: new MemoryStore(), prisma: null } });
});
afterEach(async () => app.close());

const credentials = { username: 'alice', password: 'alice123' };

function loginWith(headers: Record<string, string>, payload: string | object = credentials) {
  return app.inject({ method: 'POST', url: '/api/auth/ldap/login', headers, payload });
}

describe('login CSRF', () => {
  it('rejects a cross-site form post (text/plain body)', async () => {
    const res = await loginWith({ 'content-type': 'text/plain' }, JSON.stringify(credentials));
    expect(res.statusCode).toBe(415);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects urlencoded form posts', async () => {
    const res = await loginWith(
      { 'content-type': 'application/x-www-form-urlencoded' },
      'username=alice&password=alice123',
    );
    expect(res.statusCode).toBe(415);
  });

  it.each([
    [{ 'sec-fetch-site': 'cross-site' }],
    [{ 'sec-fetch-site': 'same-site' }],
    [{ origin: 'https://evil.example' }],
    [{ origin: 'null' }],
    [{ origin: 'http://files.example.org' }],
  ])('rejects cross-origin login %j', async (headers) => {
    const res = await loginWith(headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it('accepts same-origin browser logins and non-browser clients', async () => {
    expect((await loginWith({ origin: APP_URL, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await loginWith({})).statusCode).toBe(200);
  });

  it('accepts the origin the request was addressed to (reverse proxy without APP_URL match)', async () => {
    const res = await loginWith({ origin: 'http://internal:8080', host: 'internal:8080' });
    expect(res.statusCode).toBe(200);
  });
});

describe('cross-site requests with a valid session', () => {
  it('are rejected even with the right CSRF token', async () => {
    const login = await loginWith({});
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const headers = { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: login.json().csrfToken };

    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);

    const sameOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, origin: APP_URL },
    });
    expect(sameOrigin.statusCode).toBe(200);
  });
});
