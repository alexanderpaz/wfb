import { beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateDirectory,
  defaultClientFactory,
  DirectoryUnavailableError,
  type DirectoryConfig,
} from '../../src/auth/directory.js';
import { FakeDirectory, sampleDirectory } from './fake-ldap.js';

const ldapConfig: DirectoryConfig = {
  kind: 'ldap',
  label: 'LDAP',
  url: 'ldap://fake',
  bindDn: 'cn=readonly,dc=example,dc=org',
  bindPassword: 'readonly',
  baseDn: 'dc=example,dc=org',
  userFilter: '(uid={{username}})',
  groupAttribute: 'memberOf',
  startTls: false,
  tlsRejectUnauthorized: true,
  adDomain: undefined,
};

let dir: FakeDirectory;
const auth = (username: string, password: string, cfg: DirectoryConfig = ldapConfig) =>
  authenticateDirectory(cfg, username, password, { clientFactory: dir.factory });

beforeEach(() => {
  dir = sampleDirectory();
});

describe('authenticateDirectory (ldap)', () => {
  it('returns the user with groups from memberOf', async () => {
    const user = await auth('Alice', 'alice123');
    expect(user).toEqual({
      id: 'ldap:alice',
      username: 'alice',
      displayName: 'Alice Admin',
      email: 'alice@example.org',
      groups: ['engineering', 'staff'],
      provider: 'ldap',
    });
    expect(dir.calls.filter((c) => c.op === 'bind').map((c) => c.arg)).toEqual([
      'cn=readonly,dc=example,dc=org',
      'uid=alice,ou=people,dc=example,dc=org',
    ]);
  });

  it('falls back to a member/uniqueMember group search', async () => {
    const user = await auth('carol', 'carol123');
    expect(user?.groups).toEqual(['finance']);
    expect(user?.displayName).toBe('Carol C.');
    expect(user?.email).toBeNull();
    expect(dir.filters()).toContain(
      '(|(member=uid=carol,ou=people,dc=example,dc=org)(uniqueMember=uid=carol,ou=people,dc=example,dc=org))',
    );
  });

  it('rejects a wrong password', async () => {
    expect(await auth('alice', 'nope')).toBeNull();
  });

  it('rejects an empty password without binding as the user', async () => {
    expect(await auth('alice', '')).toBeNull();
    expect(dir.calls).toEqual([]);
  });

  it('rejects unknown users', async () => {
    expect(await auth('mallory', 'x')).toBeNull();
  });

  it('escapes the username in the search filter (LDAP injection)', async () => {
    expect(await auth('*', 'alice123')).toBeNull();
    expect(await auth('alice)(uid=*', 'alice123')).toBeNull();
    expect(dir.filters()).toEqual(['(uid=\\2a)', '(uid=alice\\29\\28uid=\\2a)']);
  });

  it('rejects ambiguous matches', async () => {
    const cfg = { ...ldapConfig, userFilter: '(objectClass={{username}})' };
    dir.entries.forEach((e) => (e.attrs.objectClass = 'person'));
    expect(await auth('person', 'alice123', cfg)).toBeNull();
  });

  it('binds anonymously when there is no service account', async () => {
    const user = await auth('alice', 'alice123', { ...ldapConfig, bindDn: undefined, bindPassword: undefined });
    expect(user?.username).toBe('alice');
    expect(dir.calls.filter((c) => c.op === 'bind').map((c) => c.arg)).toEqual([
      'uid=alice,ou=people,dc=example,dc=org',
    ]);
  });

  it('uses StartTLS when configured and always unbinds', async () => {
    await auth('alice', 'wrong', { ...ldapConfig, startTls: true });
    const clients = new Set(dir.calls.map((c) => c.client));
    for (const client of clients) {
      const ops = dir.calls.filter((c) => c.client === client).map((c) => c.op);
      expect(ops[0]).toBe('startTLS');
      expect(ops.at(-1)).toBe('unbind');
    }
  });

  it('throws DirectoryUnavailableError when the server is down', async () => {
    dir.unavailable = true;
    await expect(auth('alice', 'alice123')).rejects.toBeInstanceOf(DirectoryUnavailableError);
  });

  it('throws DirectoryUnavailableError when the service bind fails', async () => {
    await expect(auth('alice', 'alice123', { ...ldapConfig, bindPassword: 'bad' })).rejects.toBeInstanceOf(
      DirectoryUnavailableError,
    );
  });
});

describe('defaultClientFactory', () => {
  it('only uses implicit TLS for ldaps:// urls', () => {
    const secure = (url: string) => (defaultClientFactory({ ...ldapConfig, url }) as unknown as { secure: boolean }).secure;
    expect(secure('ldap://localhost:389')).toBe(false);
    expect(secure('ldaps://localhost:636')).toBe(true);
  });
});

describe('authenticateDirectory (ad)', () => {
  const adConfig: DirectoryConfig = {
    ...ldapConfig,
    kind: 'ad',
    bindDn: undefined,
    bindPassword: undefined,
    adDomain: 'corp.local',
    userFilter: '(sAMAccountName={{username}})',
    baseDn: 'DC=corp,DC=local',
  };
  const jdoeDn = 'CN=John Doe,OU=Users,DC=corp,DC=local';

  beforeEach(() => {
    dir = new FakeDirectory().add({
      dn: jdoeDn,
      password: 'Secret1!',
      attrs: {
        sAMAccountName: 'JDoe',
        cn: 'John Doe',
        displayName: 'John Doe',
        mail: 'jdoe@corp.local',
        memberOf: 'CN=Finance,OU=Groups,DC=corp,DC=local',
      },
    });
    dir.upns.set('jdoe@corp.local', { password: 'Secret1!' });
    dir.nested.set(jdoeDn.toLowerCase(), ['Finance', 'All Staff']);
  });

  it('binds with the UPN and resolves nested groups', async () => {
    const user = await auth('jdoe', 'Secret1!', adConfig);
    expect(user).toMatchObject({
      id: 'ad:jdoe',
      username: 'jdoe',
      displayName: 'John Doe',
      provider: 'ad',
      groups: ['All Staff', 'Finance'],
    });
    expect(dir.calls.filter((c) => c.op === 'bind').map((c) => c.arg)).toEqual(['jdoe@corp.local']);
    expect(dir.filters()).toEqual([
      '(sAMAccountName=jdoe)',
      '(member:1.2.840.113556.1.4.1941:=CN=John Doe,OU=Users,DC=corp,DC=local)',
    ]);
  });

  it('rejects a wrong password on the UPN bind', async () => {
    expect(await auth('jdoe', 'bad', adConfig)).toBeNull();
  });

  it('uses the service account when configured', async () => {
    dir.add({ dn: 'CN=svc,DC=corp,DC=local', password: 'svc', attrs: { cn: 'svc' } });
    const user = await auth('jdoe', 'Secret1!', { ...adConfig, bindDn: 'CN=svc,DC=corp,DC=local', bindPassword: 'svc' });
    expect(user?.username).toBe('jdoe');
    expect(dir.calls.filter((c) => c.op === 'bind').map((c) => c.arg)).toEqual(['CN=svc,DC=corp,DC=local', jdoeDn]);
  });

  it('keeps direct groups when the nested search fails', async () => {
    dir.nested.clear();
    const orig = dir.factory;
    dir.factory = () => {
      const c = orig();
      const search = c.search.bind(c);
      c.search = async (base, opts) => {
        if (String(opts.filter).includes('1.2.840.113556.1.4.1941')) throw new Error('unsupported');
        return search(base, opts);
      };
      return c;
    };
    const user = await auth('jdoe', 'Secret1!', adConfig);
    expect(user?.groups).toEqual(['Finance']);
  });
});
