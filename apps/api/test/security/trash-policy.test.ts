import { TrashListResponse, type User } from '@wfb/contracts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, users, type Fixture } from '../files/fixture.js';

// team: bob rwd, alice rw, carol r. inbox: public write-only drop box, bob rwd.
const EXTRA = `
  - id: team
    name: Equipo
    path: HOMES/../team
    visibility: private
    acl:
      - user: bob
        permissions: [read, write, delete]
      - user: alice
        permissions: [read, write]
      - user: carol
        permissions: [read]
  - id: inbox
    name: Buzón público
    path: HOMES/../inbox
    visibility: public
    permissions: [write]
    acl:
      - user: bob
        permissions: [read, write, delete]
`;

let fx: Fixture;

beforeEach(async () => {
  fx = await createFixture({ yamlExtra: EXTRA });
  await fx.dir('team');
  await fx.dir('inbox');
});
afterEach(() => fx.cleanup());

async function as(user: User) {
  const app = await fx.app(user);
  return {
    list: (share: string) => app.inject({ method: 'GET', url: `/api/trash?share=${share}` }),
    restore: (share: string, ids: string[]) =>
      app.inject({ method: 'POST', url: '/api/trash/restore', payload: { share, ids } }),
    purge: (share: string, ids: string[]) =>
      app.inject({ method: 'POST', url: '/api/trash/purge', payload: { share, ids } }),
    del: (share: string, p: string) =>
      app.inject({ method: 'POST', url: '/api/files/delete', payload: { items: [{ share, path: p }] } }),
  };
}

async function trashedBy(user: User, share: string, file: string) {
  await fx.file(`${share}/${file}`, `content of ${file}`);
  const client = await as(user);
  expect((await client.del(share, `/${file}`)).json().results[0].status).toBe('trashed');
  const items = TrashListResponse.parse((await client.list(share)).json()).items;
  return items.find((i) => i.name === file)!;
}

describe('trash visibility policy', () => {
  it('users with read + write see items deleted by others and can restore but not purge', async () => {
    const item = await trashedBy(users.bob, 'team', 'plan.txt');
    const alice = await as(users.alice);
    const list = await alice.list('team');
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([expect.objectContaining({ id: item.id, deletedBy: 'Bob' })]);

    expect((await alice.purge('team', [item.id])).statusCode).toBe(403);
    expect((await alice.restore('team', [item.id])).statusCode).toBe(200);
    expect(await readFile(path.join(fx.root, 'team/plan.txt'), 'utf8')).toBe('content of plan.txt');
  });

  it('read-only users neither see, restore nor purge trash items', async () => {
    const item = await trashedBy(users.bob, 'team', 'secret.txt');
    const carol = await as(users.carol);
    expect((await carol.list('team')).statusCode).toBe(403);
    expect((await carol.restore('team', [item.id])).statusCode).toBe(403);
    expect((await carol.purge('team', [item.id])).statusCode).toBe(403);
    expect((await (await as(users.bob)).list('team')).json().items).toHaveLength(1);
  });

  it('write-only drop boxes never reveal deleted names', async () => {
    const item = await trashedBy(users.bob, 'inbox', 'cv.pdf');
    const carol = await as(users.carol);
    expect((await carol.list('inbox')).statusCode).toBe(403);
    expect((await carol.restore('inbox', [item.id])).statusCode).toBe(403);
    expect((await carol.purge('inbox', [item.id])).statusCode).toBe(403);
  });

  it('users without access to a private share get 404 (no existence leak)', async () => {
    const item = await trashedBy(users.bob, 'eng', 'design.txt');
    for (const user of [users.alice, users.carol]) {
      const client = await as(user);
      expect((await client.list('eng')).statusCode).toBe(404);
      expect((await client.restore('eng', [item.id])).statusCode).toBe(404);
      expect((await client.purge('eng', [item.id])).statusCode).toBe(404);
    }
    expect((await (await as(users.bob)).list('eng')).json().items).toHaveLength(1);
  });

  it('a trash id from one share cannot be restored or purged through another share', async () => {
    const item = await trashedBy(users.bob, 'eng', 'only-eng.txt');
    const bob = await as(users.bob);
    expect((await bob.restore('team', [item.id])).statusCode).toBe(404);
    expect((await bob.purge('team', [item.id])).statusCode).toBe(200);
    expect((await bob.list('eng')).json().items).toHaveLength(1);
  });
});
