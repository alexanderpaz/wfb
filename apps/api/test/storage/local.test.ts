import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareEntries, mimeFor, toFileEntry } from '../../src/storage/entries.js';
import { LocalStorageProvider } from '../../src/storage/local.js';
import { freeName, numberedName, sanitizeFileName } from '../../src/storage/names.js';

let tmp: string;
let root: string;
let sibling: string;
let fs: LocalStorageProvider;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'wfb-storage-'));
  root = path.join(tmp, 'share');
  sibling = path.join(tmp, 'share-secret');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, '.wfb-trash'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(root, 'docs', 'a.txt'), 'A');
  await writeFile(path.join(root, '.wfb-trash', 'old.txt'), 'old');
  await writeFile(path.join(sibling, 'secret.txt'), 'secret');
  await symlink('/etc', path.join(root, 'etc-link'));
  await symlink(sibling, path.join(root, 'sibling-link'));
  await symlink(path.join(root, 'docs'), path.join(root, 'docs-link'));
  await symlink(path.join(tmp, 'nowhere'), path.join(root, 'dangling'));
  fs = new LocalStorageProvider(root, { trashDirName: '.wfb-trash' });
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe('LocalStorageProvider path safety', () => {
  it('rejects ".." paths', async () => {
    await expect(fs.realPath('/../share-secret')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses symlinks escaping the share (outside dir and sibling share)', async () => {
    for (const p of ['/etc-link', '/etc-link/passwd', '/sibling-link/secret.txt', '/sibling-link/new/x']) {
      await expect(fs.realPath(p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(fs.list('/etc-link')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fs.createReadStream('/sibling-link/secret.txt')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(fs.writeFile('/sibling-link/x.txt', Readable.from(['x']))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(fs.mkdir('/etc-link', 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fs.copy('/sibling-link', { provider: fs, path: '/stolen' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await readdir(sibling)).toEqual(['secret.txt']);
  });

  it('refuses going through dangling symlinks', async () => {
    await expect(fs.realPath('/dangling/x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('follows symlinks that stay inside the share', async () => {
    expect(await fs.realPath('/docs-link/a.txt')).toBe(path.join(await fs.realPath('/docs'), 'a.txt'));
  });

  it('refuses rename/move/delete on the root', async () => {
    await expect(fs.rename('/', 'x')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(fs.remove('/')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(fs.move('/', { provider: fs, path: '/docs/x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('hides the trash dir and makes it unreachable', async () => {
    const names = (await fs.list('/')).map((e) => e.name).sort();
    expect(names).toEqual(['docs', 'docs-link']);
    await expect(fs.list('/.wfb-trash')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fs.stat('/.WFB-TRASH/old.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fs.mkdir('/', '.wfb-trash')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(fs.rename('/docs', '.wfb-trash')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('shows dotfiles', async () => {
    await writeFile(path.join(root, '.env'), 'x');
    expect((await fs.list('/')).map((e) => e.name)).toContain('.env');
  });

  it('deleting a symlink removes the link, not its target', async () => {
    await fs.remove('/docs-link');
    expect(await readFile(path.join(root, 'docs', 'a.txt'), 'utf8')).toBe('A');
  });
});

describe('LocalStorageProvider operations', () => {
  it('writes atomically and never leaves temp files on failure', async () => {
    const failing = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('boom'));
      },
    });
    await expect(fs.writeFile('/docs/b.txt', failing)).rejects.toThrow('boom');
    expect(await readdir(path.join(root, 'docs'))).toEqual(['a.txt']);
    await expect(fs.writeFile('/docs/a.txt', Readable.from(['new']))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await readdir(path.join(root, 'docs'))).toEqual(['a.txt']);
    await fs.writeFile('/docs/a.txt', Readable.from(['new']), { overwrite: true });
    expect(await readFile(path.join(root, 'docs', 'a.txt'), 'utf8')).toBe('new');
  });

  it('copies and moves recursively, refusing a folder into itself', async () => {
    await fs.copy('/docs', { provider: fs, path: '/docs2' });
    expect(await readFile(path.join(root, 'docs2', 'a.txt'), 'utf8')).toBe('A');
    await expect(fs.copy('/docs', { provider: fs, path: '/docs/sub' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await fs.move('/docs2', { provider: fs, path: '/docs/moved' });
    expect(await readdir(path.join(root, 'docs', 'moved'))).toEqual(['a.txt']);
  });

  it('serves byte ranges', async () => {
    await writeFile(path.join(root, 'n.txt'), '0123456789');
    const chunks: Buffer[] = [];
    for await (const c of await fs.createReadStream('/n.txt', { start: 2, end: 4 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('234');
  });
});

describe('entries and names', () => {
  it('maps mime and previewable', () => {
    const at = new Date(0);
    const file = (name: string, office = false) =>
      toFileEntry({ name, path: `/${name}`, type: 'file', size: 1, modifiedAt: at }, { office });
    expect(file('a.png')).toMatchObject({ mime: 'image/png', previewable: true });
    expect(file('a.pdf').previewable).toBe(true);
    expect(file('a.ts')).toMatchObject({ mime: 'text/x-typescript', previewable: true });
    expect(file('a.yaml').previewable).toBe(true);
    expect(file('a.mp4').previewable).toBe(true);
    expect(file('a.zip')).toMatchObject({ mime: 'application/zip', previewable: false });
    expect(file('a.docx').previewable).toBe(false);
    expect(file('a.docx', true).previewable).toBe(true);
    expect(file('noext')).toMatchObject({ mime: 'application/octet-stream', previewable: false });
    expect(
      toFileEntry({ name: 'd', path: '/d', type: 'directory', size: 99, modifiedAt: at }, { office: true }),
    ).toEqual({
      name: 'd',
      path: '/d',
      type: 'directory',
      size: 0,
      modifiedAt: at.toISOString(),
      mime: null,
      previewable: false,
    });
    expect(mimeFor('x.json')).toBe('application/json');
  });

  it('sorts folders first, then natural Spanish order', () => {
    const list = [
      { type: 'file', name: 'b10.txt' },
      { type: 'file', name: 'B2.txt' },
      { type: 'directory', name: 'zeta' },
      { type: 'file', name: 'árbol.txt' },
      { type: 'file', name: 'ñandú.txt' },
      { type: 'file', name: 'nube.txt' },
      { type: 'directory', name: 'Alfa' },
    ].sort(compareEntries);
    expect(list.map((e) => e.name)).toEqual([
      'Alfa',
      'zeta',
      'árbol.txt',
      'B2.txt',
      'b10.txt',
      'nube.txt',
      'ñandú.txt',
    ]);
  });

  it('builds numbered names and sanitizes uploads', async () => {
    expect(numberedName('report.pdf', 1, false)).toBe('report (1).pdf');
    expect(numberedName('folder.v2', 2, true)).toBe('folder.v2 (2)');
    expect(numberedName('.bashrc', 1, false)).toBe('.bashrc (1)');
    const taken = new Set(['a (1).txt', 'a (2).txt']);
    expect(await freeName('a.txt', false, async (c) => taken.has(c))).toBe('a (3).txt');
    expect(sanitizeFileName('C:\\Users\\x\\evil.txt')).toBe('evil.txt');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..')).toBeNull();
    expect(sanitizeFileName('a/')).toBeNull();
    expect(sanitizeFileName(' \u0000 ')).toBeNull();
  });
});
