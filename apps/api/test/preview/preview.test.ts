import { PreviewInfoResponse } from '@wfb/contracts';
import { chmod, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OfficeConverter } from '../../src/preview/office.js';
import { PDF_CSP, PREVIEW_CSP, trimPartialUtf8 } from '../../src/preview/routes.js';
import { ThumbnailService } from '../../src/preview/thumbnails.js';
import { createFixture, users, type Fixture } from '../files/fixture.js';

let fx: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fx = await createFixture();
  app = await fx.app(users.alice);
});
afterEach(() => fx.cleanup());

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const get = (url: string, headers: Record<string, string> = {}, on = app) =>
  on.inject({ method: 'GET', url, headers });
const info = async (share: string, p: string, on = app) => {
  const res = await get(`/api/preview/info?${q({ share, path: p })}`, {}, on);
  expect(res.statusCode).toBe(200);
  return PreviewInfoResponse.parse(res.json());
};
const content = (share: string, p: string, headers: Record<string, string> = {}, on = app) =>
  get(`/api/preview/content?${q({ share, path: p })}`, headers, on);
const thumb = (share: string, p: string, size?: string, headers: Record<string, string> = {}) =>
  get(`/api/preview/thumbnail?${q({ share, path: p, ...(size ? { size } : {}) })}`, headers);

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#3366ff' } })
    .png()
    .toBuffer();

describe('GET /api/preview/info', () => {
  it('classifies entries by extension and mime', async () => {
    await fx.file('public/a.png', await png(4, 4));
    await fx.file('public/b.JPG', 'x');
    await fx.file('public/c.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fx.file('public/d.pdf', '%PDF');
    await fx.file('public/e.ts', 'const a = 1;');
    await fx.file('public/f.md', '# hi');
    await fx.file('public/g.mp3', 'x');
    await fx.file('public/h.mov', 'x');
    await fx.file('public/i.docx', 'x');
    await fx.file('public/j.zip', 'x');
    await fx.file('public/k.json', '{}');
    await fx.file('public/Dockerfile', 'FROM node');
    await fx.dir('public/folder');

    const kinds: Record<string, unknown> = {};
    for (const name of [
      'a.png',
      'b.JPG',
      'c.svg',
      'd.pdf',
      'e.ts',
      'f.md',
      'g.mp3',
      'h.mov',
      'i.docx',
      'j.zip',
    ]) {
      kinds[name] = (await info('public', `/${name}`)).kind;
    }
    expect(kinds).toEqual({
      'a.png': 'image',
      'b.JPG': 'image',
      'c.svg': 'image',
      'd.pdf': 'pdf',
      'e.ts': 'text',
      'f.md': 'text',
      'g.mp3': 'audio',
      'h.mov': 'video',
      'i.docx': 'none',
      'j.zip': 'none',
    });
    expect(await info('public', '/e.ts')).toEqual({
      kind: 'text',
      mime: 'text/x-typescript',
      contentUrl: '/api/preview/content?share=public&path=%2Fe.ts',
      truncated: false,
      language: 'typescript',
    });
    expect((await info('public', '/k.json')).language).toBe('json');
    expect((await info('public', '/Dockerfile')).language).toBe('dockerfile');
    expect(await info('public', '/folder')).toEqual({ kind: 'none', mime: null, contentUrl: null });
    expect((await info('public', '/j.zip')).contentUrl).toBeNull();
  });

  it('url-encodes the content url and reports truncation', async () => {
    await fx.file('public/dir con espacios/ñ & #1.log', 'a'.repeat(1024 * 1024 + 1));
    const body = await info('public', '/dir con espacios/ñ & #1.log');
    expect(body.truncated).toBe(true);
    const url = new URL(body.contentUrl!, 'http://x');
    expect(url.pathname).toBe('/api/preview/content');
    expect(url.searchParams.get('path')).toBe('/dir con espacios/ñ & #1.log');
  });

  it('reports office documents only when enabled', async () => {
    await fx.file('public/i.docx', 'x');
    const office = await fx.app(users.alice, { OFFICE_PREVIEW: 'true' });
    expect((await info('public', '/i.docx', office)).kind).toBe('office');
  });

  it('enforces read permission through resolveRef', async () => {
    await fx.file('eng/a.txt', 'secret');
    await fx.file('dropbox/a.txt', 'secret');
    expect((await get(`/api/preview/info?${q({ share: 'eng', path: '/a.txt' })}`)).statusCode).toBe(404);
    expect((await content('eng', '/a.txt')).statusCode).toBe(404);
    expect((await thumb('eng', '/a.txt')).statusCode).toBe(404);
    const carol = await fx.app(users.carol);
    expect((await content('dropbox', '/a.txt', {}, carol)).statusCode).toBe(404);
    await symlink(path.join(fx.root, 'eng'), path.join(fx.root, 'public', 'eng-link'));
    expect((await content('public', '/eng-link/a.txt')).statusCode).toBe(403);
    expect((await thumb('public', '/eng-link/a.txt')).statusCode).toBe(403);
    expect((await get(`/api/preview/info?${q({ share: 'public', path: '/../eng/a.txt' })}`)).statusCode).toBe(
      400,
    );
    expect((await content('public', '/missing.txt')).statusCode).toBe(404);
  });
});

describe('GET /api/preview/thumbnail', () => {
  it('returns a webp inside the requested size and caches it on disk', async () => {
    await fx.file('public/big.png', await png(800, 400));
    let res = await thumb('public', '/big.png', 'small');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.headers['x-thumbnail-cache']).toBe('miss');
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 64, 32]);
    const files = await readdir(path.join(fx.tmp, 'data', 'thumbs'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.webp$/);

    const etag = res.headers.etag as string;
    res = await thumb('public', '/big.png', 'small');
    expect(res.headers['x-thumbnail-cache']).toBe('hit');
    expect(res.headers.etag).toBe(etag);
    res = await thumb('public', '/big.png', 'small', { 'if-none-match': etag });
    expect(res.statusCode).toBe(304);

    res = await thumb('public', '/big.png');
    expect((await sharp(res.rawPayload).metadata()).width).toBe(256);
    expect(res.headers['x-thumbnail-cache']).toBe('miss');
  });

  it('invalidates the cache when the file changes', async () => {
    const abs = await fx.file('public/a.png', await png(100, 100));
    const first = await thumb('public', '/a.png', 'small');
    await writeFile(abs, await png(50, 100));
    await utimes(abs, new Date(), new Date(Date.now() + 5000));
    const second = await thumb('public', '/a.png', 'small');
    expect(second.headers['x-thumbnail-cache']).toBe('miss');
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect((await sharp(second.rawPayload).metadata()).width).toBe(32);
  });

  it('applies EXIF orientation and never enlarges', async () => {
    const jpg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await fx.file('public/rot.jpg', jpg);
    const meta = await sharp((await thumb('public', '/rot.jpg', 'large')).rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([20, 40]);
  });

  it('renders the first frame of a gif and rasterizes svg', async () => {
    await fx.file(
      'public/a.gif',
      await sharp(await png(30, 30))
        .gif()
        .toBuffer(),
    );
    expect((await thumb('public', '/a.gif', 'small')).headers['content-type']).toBe('image/webp');
    await fx.file(
      'public/a.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>',
    );
    const meta = await sharp((await thumb('public', '/a.svg', 'small')).rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 64, 32]);
  });

  it('validates the size and rejects unsupported or corrupt files with 415', async () => {
    await fx.file('public/a.png', await png(10, 10));
    await fx.file('public/a.txt', 'text');
    await fx.file('public/broken.png', 'not an image');
    await fx.dir('public/folder');
    let res = await thumb('public', '/a.png', 'huge');
    expect(res.statusCode).toBe(400);
    for (const p of ['/a.txt', '/broken.png', '/folder']) {
      res = await thumb('public', p);
      expect(res.statusCode, p).toBe(415);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    }
  });

  it('limits input bytes and decoded pixels', async () => {
    const ref = await app.resolveRef(users.alice, { share: 'public', path: '/' }, 'read');
    await fx.file('public/a.png', await png(200, 200));
    const target = { ...ref, virtualPath: '/a.png' };
    const stat = await ref.provider.stat('/a.png');
    const opts = { cacheDir: path.join(fx.tmp, 'thumbs-test'), concurrency: 1 };
    const pixels = new ThumbnailService({ ...opts, maxInputBytes: 1e9, maxInputPixels: 100 });
    await expect(pixels.get(target, stat, 'small')).rejects.toMatchObject({ statusCode: 415 });
    const bytes = new ThumbnailService({ ...opts, maxInputBytes: 10, maxInputPixels: 1e9 });
    await expect(bytes.get(target, stat, 'small')).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe('GET /api/preview/content', () => {
  it('serves text as utf-8 with security headers', async () => {
    await fx.file('public/a.html', '<script>alert(1)</script>');
    const res = await content('public', '/a.html');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-preview-truncated']).toBe('false');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
    expect(res.body).toBe('<script>alert(1)</script>');
  });

  it('truncates text to 1 MiB without splitting characters', async () => {
    await fx.file('public/big.txt', 'a'.repeat(1024 * 1024 - 1) + 'ñandú');
    const res = await content('public', '/big.txt');
    expect(res.headers['x-preview-truncated']).toBe('true');
    expect(res.rawPayload.length).toBe(1024 * 1024 - 1);
    expect(res.body.endsWith('a')).toBe(true);
    expect(trimPartialUtf8(Buffer.from('añ')).toString()).toBe('añ');
    expect(trimPartialUtf8(Buffer.from('añ').subarray(0, 2)).toString()).toBe('a');
    expect(trimPartialUtf8(Buffer.from('a€').subarray(0, 3)).toString()).toBe('a');
  });

  it('rejects binary text files and empty files are fine', async () => {
    await fx.file('public/bin.log', Buffer.from([0x41, 0x00, 0x42]));
    await fx.file('public/empty.txt', '');
    let res = await content('public', '/bin.log');
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('BAD_REQUEST');
    res = await content('public', '/empty.txt');
    expect([res.statusCode, res.body]).toEqual([200, '']);
  });

  it('streams media with range support inline', async () => {
    await fx.file('public/v.mp4', Buffer.from('0123456789'));
    await fx.file('public/s.mp3', Buffer.from('abcdefghij'));
    let res = await content('public', '/v.mp4', { range: 'bytes=2-5' });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
    res = await content('public', '/s.mp3', { range: 'bytes=-3' });
    expect([res.statusCode, res.body, res.headers['accept-ranges']]).toEqual([206, 'hij', 'bytes']);
    res = await content('public', '/s.mp3', { range: 'bytes=50-' });
    expect(res.statusCode).toBe(416);
  });

  it('serves images and pdfs inline', async () => {
    await fx.file('public/a.png', await png(5, 5));
    await fx.file('public/d.pdf', '%PDF-1.4');
    let res = await content('public', '/a.png');
    expect([res.headers['content-type'], res.headers['content-disposition']]).toEqual([
      'image/png',
      'inline; filename="a.png"; filename*=UTF-8\'\'a.png',
    ]);
    res = await content('public', '/d.pdf');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-security-policy']).toBe(PDF_CSP);
    expect(res.body).toBe('%PDF-1.4');
  });

  it('never serves svg raw', async () => {
    await fx.file(
      'public/x.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    );
    const res = await content('public', '/x.svg');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(res.body).not.toContain('<script');
  });

  it('returns 415 for unsupported files, folders and disabled office', async () => {
    await fx.file('public/a.zip', 'PK');
    await fx.file('public/a.docx', 'x');
    await fx.dir('public/folder');
    for (const p of ['/a.zip', '/a.docx', '/folder']) {
      const res = await content('public', p);
      expect(res.statusCode, p).toBe(415);
      expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
    }
  });
});

describe('office conversion', () => {
  async function fakeSoffice(script: string): Promise<string> {
    const file = path.join(fx.tmp, 'fake-soffice');
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
    return file;
  }

  const CONVERT = `
log="$(dirname "$0")/calls.log"
echo "$@" >> "$log"
out=""; prev=""; last=""
for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; last="$a"; done
name=$(basename "$last"); name="\${name%.*}"
printf '%%PDF-1.4 converted' > "$out/$name.pdf"`;

  it('converts with an isolated profile and caches the pdf', async () => {
    await fx.file('public/Informe anual.docx', 'fake docx');
    const soffice = await fakeSoffice(CONVERT);
    const office = await fx.app(users.alice, { OFFICE_PREVIEW: 'true', SOFFICE_PATH: soffice });
    let res = await content('public', '/Informe anual.docx', {}, office);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="Informe anual.pdf"/);
    expect(res.body).toBe('%PDF-1.4 converted');
    res = await content('public', '/Informe anual.docx', { range: 'bytes=0-3' }, office);
    expect([res.statusCode, res.body]).toEqual([206, '%PDF']);

    const calls = (await readFile(path.join(fx.tmp, 'calls.log'), 'utf8')).trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^-env:UserInstallation=file:\/\/\S+\/lo-profile --headless /);
    expect(calls[0]).toMatch(/--convert-to pdf --outdir \S+\/out \S+\/input\.docx$/);
    expect(await readdir(path.join(fx.tmp, 'data', 'office'))).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}\.pdf$/),
    ]);
  });

  it('returns 415 when soffice is missing or fails', async () => {
    await fx.file('public/a.xlsx', 'x');
    const missing = await fx.app(users.alice, {
      OFFICE_PREVIEW: 'true',
      SOFFICE_PATH: '/nonexistent/soffice',
    });
    expect((await content('public', '/a.xlsx', {}, missing)).statusCode).toBe(415);
    const failing = await fx.app(users.alice, {
      OFFICE_PREVIEW: 'true',
      SOFFICE_PATH: await fakeSoffice('exit 3'),
    });
    const res = await content('public', '/a.xlsx', {}, failing);
    expect(res.statusCode).toBe(415);
    expect(res.json().error.message).toMatch(/exit code 3/);
  });

  it('kills conversions that exceed the timeout', async () => {
    await fx.file('public/slow.pptx', 'x');
    const converter = new OfficeConverter({
      enabled: true,
      sofficePath: await fakeSoffice('sleep 5'),
      cacheDir: path.join(fx.tmp, 'office-test'),
      timeoutMs: 200,
      maxInputBytes: 1e6,
    });
    const ref = await app.resolveRef(users.alice, { share: 'public', path: '/slow.pptx' }, 'read');
    const started = Date.now();
    await expect(converter.toPdf(ref, await ref.provider.stat(ref.virtualPath))).rejects.toMatchObject({
      statusCode: 415,
      message: 'Office conversion timed out',
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
