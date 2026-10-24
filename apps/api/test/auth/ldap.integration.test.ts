import { createConnection } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticateDirectory, DirectoryUnavailableError } from '../../src/auth/directory.js';
import { createTestApp, testConfig } from '../helpers.js';

const LDAP_URL = process.env.TEST_LDAP_URL ?? 'ldap://localhost:1389';

const env = {
  DIRECTORY_KIND: 'ldap',
  LDAP_URL,
  LDAP_BASE_DN: 'dc=example,dc=org',
  LDAP_BIND_DN: 'cn=readonly,dc=example,dc=org',
  LDAP_BIND_PASSWORD: 'readonly',
};

function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port || 389), timeout: 1000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

const ldapUp = await reachable(LDAP_URL);
const directory = testConfig(env).directory!;

describe.skipIf(!ldapUp)(`LDAP integration (OpenLDAP at ${LDAP_URL})`, () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it.each([
    ['alice', 'alice123', ['engineering', 'staff']],
    ['bob', 'bob123', ['engineering', 'staff']],
    ['carol', 'carol123', ['finance', 'staff']],
  ])('authenticates %s with groups', async (username, password, groups) => {
    const user = await authenticateDirectory(directory, username, password);
    expect(user).toMatchObject({ id: `ldap:${username}`, username, provider: 'ldap', groups });
    expect(user?.email).toBe(`${username}@example.org`);
  });

  it('resolves groups through uniqueMember when memberOf is unavailable', async () => {
    const user = await authenticateDirectory({ ...directory, groupAttribute: 'nonexistentAttr' }, 'carol', 'carol123');
    expect(user?.groups).toEqual(['finance', 'staff']);
  });

  it('rejects wrong passwords and unknown users', async () => {
    expect(await authenticateDirectory(directory, 'alice', 'bob123')).toBeNull();
    expect(await authenticateDirectory(directory, 'nobody', 'x')).toBeNull();
  });

  it('is not vulnerable to filter injection', async () => {
    expect(await authenticateDirectory(directory, '*', 'alice123')).toBeNull();
    expect(await authenticateDirectory(directory, 'a*', 'alice123')).toBeNull();
    expect(await authenticateDirectory(directory, '*)(uid=alice', 'alice123')).toBeNull();
    expect(await authenticateDirectory(directory, 'alice)(|(uid=*', 'alice123')).toBeNull();
  });

  it('reports a misconfigured service account as unavailable', async () => {
    await expect(authenticateDirectory({ ...directory, bindPassword: 'wrong' }, 'alice', 'alice123')).rejects.toBeInstanceOf(
      DirectoryUnavailableError,
    );
  });

  it('logs in end to end through the API', async () => {
    app = await createTestApp({ env });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/ldap/login',
      payload: { username: 'carol', password: 'carol123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'carol', displayName: 'Carol Contable' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/ldap/login',
      payload: { username: 'carol', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe('LDAP connectivity', () => {
  it('reports an unreachable server as unavailable', async () => {
    const down = { ...directory, url: 'ldap://127.0.0.1:1' };
    await expect(authenticateDirectory(down, 'alice', 'alice123')).rejects.toBeInstanceOf(DirectoryUnavailableError);
  });
});
