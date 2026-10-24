import type { User } from '@wfb/contracts';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadSharesConfig,
  parseSharesConfig,
  SharesConfigError,
  type ShareDef,
} from '../../src/acl/config.js';
import { effectivePermissions, groupKey } from '../../src/acl/match.js';
import { homeDirName, ShareService } from '../../src/acl/share-service.js';
import { HttpError } from '../../src/lib/errors.js';
import { sharesYaml, users } from '../files/fixture.js';

const parse = (raw: unknown) => parseSharesConfig(raw, { file: 'shares.yaml', cwd: '/srv' });

describe('shares config', () => {
  it('validates and resolves relative paths against cwd', () => {
    const cfg = parse({
      shares: [{ id: 'docs', name: 'Docs', path: 'data/docs', visibility: 'public', permissions: ['read'] }],
      home: { enabled: true, root: 'homes' },
    });
    expect(cfg.shares[0]).toMatchObject({ path: '/srv/data/docs', description: null, acl: [] });
    expect(cfg.home).toEqual({
      name: 'Mi carpeta',
      root: '/srv/homes',
      permissions: ['read', 'write', 'delete'],
    });
  });

  it.each([
    [{ shares: [{ id: 'Bad Id', name: 'x', path: '/x', visibility: 'public' }] }, /id must be/],
    [{ shares: [{ id: 'x', name: 'x', path: '/x', visibility: 'secret' }] }, /visibility/],
    [
      { shares: [{ id: 'x', name: 'x', path: '/x', visibility: 'public', permissions: ['admin'] }] },
      /permissions/,
    ],
    [{ shares: [{ id: 'x', name: 'x', path: '/x', visibility: 'public', acl: [{ group: 'g' }] }] }, /acl/],
    [{ shares: [{ id: 'x', name: 'x', path: '/x', visibility: 'public', extra: 1 }] }, /Unrecognized/],
    [
      {
        shares: [
          { id: 'x', name: 'x', path: '/x', visibility: 'public' },
          { id: 'x', name: 'y', path: '/y', visibility: 'public' },
        ],
      },
      /duplicate share id "x"/,
    ],
    [
      {
        shares: [{ id: 'home', name: 'x', path: '/x', visibility: 'public' }],
        home: { enabled: true, root: '/h' },
      },
      /reserved/,
    ],
    [{ home: { enabled: true } }, /home.root/],
  ])('rejects invalid config %#', (raw, message) => {
    expect(() => parse(raw)).toThrow(SharesConfigError);
    expect(() => parse(raw)).toThrow(message);
  });

  it('lets HOME_ROOT override home.root', () => {
    const cfg = parseSharesConfig(
      { home: { enabled: true, root: '/yaml' } },
      { file: 'f', homeRootOverride: '/env' },
    );
    expect(cfg.home?.root).toBe('/env');
  });
});

describe('acl matching', () => {
  it('compares groups by CN, case-insensitively', () => {
    expect(groupKey('Finance')).toBe('finance');
    expect(groupKey('CN=Finance,OU=Groups,DC=corp')).toBe('finance');
    expect(groupKey('cn = Foo\\, Inc,ou=x')).toBe('foo, inc');
  });

  const share = (over: Partial<ShareDef>): ShareDef => ({
    id: 's',
    name: 's',
    description: null,
    path: '/s',
    visibility: 'private',
    permissions: [],
    acl: [],
    ...over,
  });
  const user = (groups: string[], username = 'zed'): User => ({ ...users.carol, username, groups });

  it('matches DN config against CN user groups and vice versa', () => {
    const dnConfig = share({ acl: [{ group: 'CN=Ops,OU=Groups,DC=x', permissions: ['read'] }] });
    expect(effectivePermissions(dnConfig, user(['ops']))).toEqual(['read']);
    const cnConfig = share({ acl: [{ group: 'OPS', permissions: ['read'] }] });
    expect(effectivePermissions(cnConfig, user(['cn=ops,dc=y']))).toEqual(['read']);
    expect(effectivePermissions(cnConfig, user(['cn=opsx,dc=y']))).toEqual([]);
  });

  it('unions base permissions (public only) and all matching entries', () => {
    const s = share({
      visibility: 'public',
      permissions: ['read'],
      acl: [
        { group: 'a', permissions: ['write'] },
        { user: 'ZED', permissions: ['delete'] },
        { group: 'nope', permissions: ['write'] },
      ],
    });
    expect(effectivePermissions(s, user(['A']))).toEqual(['read', 'write', 'delete']);
    expect(effectivePermissions({ ...s, visibility: 'private' }, user([], 'other'))).toEqual([]);
  });

  it('sanitizes home folder names', () => {
    expect(homeDirName('Alice')).toBe('alice');
    expect(homeDirName('CORP\\john doe')).toBe('corp_john_doe');
    expect(homeDirName('..')).toBeNull();
    expect(homeDirName('../etc')).toBe('_etc');
  });
});

describe('ShareService', () => {
  let tmp: string;
  let file: string;
  let service: ShareService | null = null;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'wfb-acl-'));
    file = path.join(tmp, 'shares.yaml');
    const home = `home:\n  enabled: true\n  root: ${tmp}/homes\n  name: Personal\n  permissions: [read, write]\n`;
    await writeFile(file, sharesYaml(tmp, home));
  });
  afterEach(async () => {
    service?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const ids = (user: User) => service!.listForUser(user).map((s) => s.id);

  it('lists public, matching private and home shares', () => {
    service = new ShareService({ file, reloadIntervalMs: 0 });
    expect(ids(users.alice)).toEqual(['home', 'public', 'finance']);
    expect(ids(users.bob)).toEqual(['home', 'public', 'eng']);
    expect(ids(users.carol)).toEqual(['home', 'public']);
    expect(service.listForUser(users.alice)).toEqual([
      { id: 'home', name: 'Personal', description: null, visibility: 'home', permissions: ['read', 'write'] },
      {
        id: 'public',
        name: 'Público',
        description: 'Para todos',
        visibility: 'public',
        permissions: ['read', 'write'],
      },
      { id: 'finance', name: 'Finanzas', description: null, visibility: 'private', permissions: ['read'] },
    ]);
    expect(service.listForUser(users.carol)[1]!.permissions).toEqual(['read']);
  });

  it('throws 404 for invisible shares and 403 for missing permissions', async () => {
    service = new ShareService({ file, reloadIntervalMs: 0 });
    await expect(service.get(users.carol, 'eng')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.get(users.carol, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // write-only ACL entry does not make a private share visible
    await expect(service.get(users.carol, 'dropbox')).rejects.toBeInstanceOf(HttpError);
    await expect(service.assert(users.carol, 'public', 'write')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.assert(users.alice, 'finance', 'delete')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.assert(users.alice, 'public', 'write')).resolves.toMatchObject({ id: 'public' });
  });

  it('creates the home folder on first access', async () => {
    service = new ShareService({ file, reloadIntervalMs: 0 });
    const home = await service.get(users.bob, 'home');
    expect(home.path).toBe(path.join(tmp, 'homes', 'bob'));
    expect((await stat(home.path)).isDirectory()).toBe(true);
  });

  it('reloads on change and keeps the last good config when invalid', async () => {
    service = new ShareService({ file, reloadIntervalMs: 0 });
    await writeFile(
      file,
      `shares:\n  - id: only\n    name: Only\n    path: ${tmp}\n    visibility: public\n`,
    );
    expect(await service.reloadIfChanged()).toBe(true);
    expect(ids(users.carol)).toEqual(['only']);
    expect(await service.reloadIfChanged()).toBe(false);
    await writeFile(file, 'shares: [ { id: "x" } ]');
    expect(await service.reloadIfChanged()).toBe(false);
    expect(ids(users.carol)).toEqual(['only']);
  });

  it('fails fast on invalid config and tolerates a missing file', async () => {
    await writeFile(file, 'shares:\n  - id: a\n');
    expect(() => new ShareService({ file, reloadIntervalMs: 0 })).toThrow(/Invalid shares config/);
    service = new ShareService({ file: path.join(tmp, 'missing.yaml'), reloadIntervalMs: 0 });
    expect(ids(users.alice)).toEqual([]);
  });
});

describe('loadSharesConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wfb-shares-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('explains a directory left by a Docker bind mount of a missing file', () => {
    expect(() => loadSharesConfig(dir)).toThrow(SharesConfigError);
    expect(() => loadSharesConfig(dir)).toThrow(/is a directory.*SHARES_CONFIG_HOST_PATH/);
  });

  it('reports a missing file', () => {
    expect(() => loadSharesConfig(path.join(dir, 'shares.yaml'))).toThrow(/file not found/);
  });
});
