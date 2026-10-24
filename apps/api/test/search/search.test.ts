import { SearchResponse } from '@wfb/contracts';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldName, SearchService } from '../../src/search/service.js';
import { createFixture, users, type Fixture } from '../files/fixture.js';

let fx: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fx = await createFixture();
  app = await fx.app(users.alice);
});
afterEach(() => fx.cleanup());

const search = async (query: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: `/api/search?${new URLSearchParams(query)}` });
  return { status: res.statusCode, body: res.statusCode === 200 ? SearchResponse.parse(res.json()) : null };
};

describe('search', () => {
  it('folds case and accents', () => {
    expect(foldName('Ingeniería ÁÉÍÓÚ Ñ')).toBe('ingenieria aeiou n');
  });

  it('finds names recursively, case- and accent-insensitively, with full virtual paths', async () => {
    await fx.file('public/Informe Ingeniería.pdf', 'pdf');
    await fx.file('public/docs/INGENIERIA notas.txt', 'n');
    await fx.dir('public/docs/deep/ingeniería');
    await fx.file('public/docs/other.txt');
    const { status, body } = await search({ share: 'public', path: '/', q: 'ingenieria' });
    expect(status).toBe(200);
    expect(body!.truncated).toBe(false);
    expect(body!.results.map((r) => r.path)).toEqual([
      '/Informe Ingeniería.pdf',
      '/docs/INGENIERIA notas.txt',
      '/docs/deep/ingeniería',
    ]);
    expect(body!.results[0]).toMatchObject({ type: 'file', size: 3, mime: 'application/pdf' });
    expect(body!.results[2]).toMatchObject({ type: 'directory', size: 0 });

    const scoped = await search({ share: 'public', path: '/docs', q: 'ÍNGEN' });
    expect(scoped.body!.results.map((r) => r.path)).toEqual([
      '/docs/INGENIERIA notas.txt',
      '/docs/deep/ingeniería',
    ]);
  });

  it('skips the trash, upload temp files and symlinks escaping the share', async () => {
    await fx.file('public/.wfb-trash/x/item/match.txt');
    await fx.file('public/.wfb-upload-0123456789abcdef.tmp');
    await fx.file('eng/match-secret.txt');
    await fx.file('public/inside/match-ok.txt');
    await symlink(path.join(fx.root, 'eng'), path.join(fx.root, 'public', 'match-escape'));
    await symlink(path.join(fx.root, 'public/inside'), path.join(fx.root, 'public', 'match-link'));
    const { body } = await search({ share: 'public', path: '/', q: 'match' });
    expect(body!.results.map((r) => r.path).sort()).toEqual(['/inside/match-ok.txt', '/match-link']);
    const tmp = await search({ share: 'public', path: '/', q: 'wfb' });
    expect(tmp.body!.results).toEqual([]);
  });

  it('limits results and reports truncation', async () => {
    for (let i = 0; i < 5; i++) await fx.file(`public/r${i}.txt`);
    const { body } = await search({ share: 'public', path: '/', q: 'r', limit: '3' });
    expect(body!.results).toHaveLength(3);
    expect(body!.truncated).toBe(true);
  });

  it('stops at the depth and visit limits', async () => {
    await fx.file('public/a/b/c/d/deep-hit.txt');
    await fx.file('public/hit.txt');
    const service = new SearchService(app.files, { maxDepth: 2, maxVisited: 1000, timeBudgetMs: 3000 });
    let res = await service.search(users.alice, { share: 'public', path: '/', q: 'hit', limit: 100 });
    expect(res).toMatchObject({ truncated: true });
    expect(res.results.map((r) => r.path)).toEqual(['/hit.txt']);

    const tiny = new SearchService(app.files, { maxDepth: 20, maxVisited: 1, timeBudgetMs: 3000 });
    res = await tiny.search(users.alice, { share: 'public', path: '/', q: 'hit', limit: 100 });
    expect(res.truncated).toBe(true);
  });

  it('validates input and permissions', async () => {
    await fx.file('public/f.txt');
    expect((await search({ share: 'public', path: '/f.txt', q: 'x' })).status).toBe(400);
    expect((await search({ share: 'public', path: '/', q: '  ' })).status).toBe(400);
    expect((await search({ share: 'eng', path: '/', q: 'x' })).status).toBe(404);
    expect((await search({ share: 'public', path: '/missing', q: 'x' })).status).toBe(404);
    expect((await search({ share: 'public', path: '/../eng', q: 'x' })).status).toBe(400);
  });
});
