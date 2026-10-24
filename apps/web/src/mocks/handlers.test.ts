// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetMockDb } from './db';
import { server } from './server';

const BASE = 'http://localhost';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const list = async (share: string, path: string) =>
  (
    (await call('GET', `/api/files?share=${share}&path=${encodeURIComponent(path)}`)).body.entries as {
      name: string;
    }[]
  ).map((e) => e.name);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetMockDb());
afterAll(() => server.close());

describe('mock API', () => {
  it('lists shares and authenticates', async () => {
    const shares = (await call('GET', '/api/shares')).body.shares as { id: string; permissions: string[] }[];
    expect(shares.map((s) => s.id)).toEqual(['public', 'engineering', 'home']);
    expect(shares[0]!.permissions).toEqual(['read']);
    expect((await call('GET', '/api/auth/me')).body).toMatchObject({ user: { username: 'ana' } });
    expect((await call('GET', '/api/auth/providers')).body).toMatchObject({ directory: { kind: 'ldap' } });
  });

  it('validates bodies with the contract schemas', async () => {
    const r = await call('POST', '/api/files/mkdir', { share: 'engineering', path: '/', name: 'a/b' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('rejects writes on a read-only share', async () => {
    const r = await call('POST', '/api/files/mkdir', { share: 'public', path: '/', name: 'x' });
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
  });

  it('returns 409 CONFLICT when every item conflicts with strategy "fail"', async () => {
    const items = [{ share: 'engineering', path: '/notas.txt' }];
    const destination = { share: 'home', path: '/' };
    expect((await call('POST', '/api/files/copy', { items, destination })).status).toBe(200);
    const r = await call('POST', '/api/files/copy', { items, destination });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: { code: 'CONFLICT', details: { conflicts: [{ share: 'engineering', path: '/notas.txt' }] } },
    });
  });

  it('applies conflict strategies', async () => {
    const items = [{ share: 'engineering', path: '/notas.txt' }];
    const destination = { share: 'engineering', path: '/Documentación' };
    await call('POST', '/api/files/copy', { items, destination });
    const skip = await call('POST', '/api/files/copy', { items, destination, conflict: 'skip' });
    expect(skip.body).toMatchObject({ mode: 'sync', results: [{ status: 'skipped' }] });
    const rename = await call('POST', '/api/files/copy', { items, destination, conflict: 'rename' });
    expect(rename.body).toMatchObject({
      results: [{ status: 'done', target: { path: '/Documentación/notas (2).txt' } }],
    });
    const over = await call('POST', '/api/files/move', { items, destination, conflict: 'overwrite' });
    expect(over.body).toMatchObject({ results: [{ status: 'done' }] });
    expect(await list('engineering', '/')).not.toContain('notas.txt');
  });

  it('refuses to move a folder into itself', async () => {
    const r = await call('POST', '/api/files/move', {
      items: [{ share: 'engineering', path: '/Proyectos' }],
      destination: { share: 'engineering', path: '/Proyectos/Alfa' },
    });
    expect(r.body).toMatchObject({ results: [{ status: 'failed' }] });
  });

  it('renames, deletes and downloads', async () => {
    const renamed = await call('POST', '/api/files/rename', {
      share: 'engineering',
      path: '/notas.txt',
      newName: 'n.txt',
    });
    expect(renamed.body).toMatchObject({ entry: { path: '/n.txt', type: 'file' } });
    const dl = await fetch(`${BASE}/api/files/download?share=engineering&path=/n.txt`);
    expect(await dl.text()).toContain('Reunión del lunes');
    const del = await call('POST', '/api/files/delete', {
      items: [{ share: 'engineering', path: '/n.txt' }],
    });
    expect(del.body).toMatchObject({ results: [{ status: 'trashed' }] });
    expect(await list('engineering', '/')).not.toContain('n.txt');
  });

  it('accepts multipart uploads with conflict handling', async () => {
    const upload = (conflict: string) => {
      const form = new FormData();
      form.append('file', new File(['hola'], 'subido.txt', { type: 'text/plain' }));
      return fetch(`${BASE}/api/files/upload?share=home&path=/&conflict=${conflict}`, {
        method: 'POST',
        body: form,
      });
    };
    const first = await upload('fail');
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ entries: [{ name: 'subido.txt', size: 4 }] });
    expect((await upload('fail')).status).toBe(409);
    expect(await (await upload('rename')).json()).toMatchObject({ entries: [{ name: 'subido (2).txt' }] });
  });
});
