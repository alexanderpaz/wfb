import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../lib/errors.js';
import type { EntryInfo, StorageProvider } from '../storage/provider.js';

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `bytes=` range. Returns null when the header should be
 * ignored (absent, other unit, multiple ranges) and 'unsatisfiable' for 416.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header);
  if (!match) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const INLINE_SAFE =
  /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|audio\/.+|video\/.+|application\/pdf|text\/plain)$/;

/** Types a browser may render in our origin without script execution (no HTML/SVG/XML). */
export function isInlineSafe(mime: string): boolean {
  return INLINE_SAFE.test(mime);
}

export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function etagFor(info: EntryInfo): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.modifiedAt.getTime()).toString(16)}"`;
}

function notModified(request: FastifyRequest, etag: string, modifiedAt: Date): boolean {
  const inm = request.headers['if-none-match'];
  if (inm) return inm.split(',').some((t) => t.trim() === etag || t.trim() === '*');
  const ims = request.headers['if-modified-since'];
  if (!ims) return false;
  const since = Date.parse(ims);
  return !Number.isNaN(since) && Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(since / 1000);
}

/** Streams a file with Range, conditional request and safe disposition support. */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: { provider: StorageProvider; virtualPath: string; info: EntryInfo; mime: string; inline: boolean },
): Promise<FastifyReply> {
  const { provider, virtualPath, info, mime } = file;
  if (info.type !== 'file') throw new HttpError('BAD_REQUEST', 'Folders cannot be downloaded');
  const etag = etagFor(info);
  const inline = file.inline && isInlineSafe(mime);

  reply
    .header('Accept-Ranges', 'bytes')
    .header('ETag', etag)
    .header('Last-Modified', info.modifiedAt.toUTCString())
    .header('Cache-Control', 'private, no-cache')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Type', mime)
    .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', info.name));

  if (notModified(request, etag, info.modifiedAt)) return reply.code(304).send();

  const ifRange = request.headers['if-range'];
  const range =
    ifRange && ifRange !== etag && ifRange !== info.modifiedAt.toUTCString()
      ? null
      : parseRange(request.headers.range, info.size);
  if (range === 'unsatisfiable') {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${info.size}`)
      .header('Content-Type', 'application/json; charset=utf-8')
      .removeHeader('Content-Disposition')
      .send({ error: { code: 'BAD_REQUEST', message: 'Requested range not satisfiable' } });
  }
  if (range) {
    const stream = await provider.createReadStream(virtualPath, range);
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
      .header('Content-Length', range.end - range.start + 1)
      .send(stream);
  }
  const stream = await provider.createReadStream(virtualPath);
  return reply.code(200).header('Content-Length', info.size).send(stream);
}
