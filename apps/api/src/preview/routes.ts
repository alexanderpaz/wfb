import {
  API_PREFIX,
  PreviewContentQuery,
  PreviewInfoQuery,
  ThumbnailQuery,
  type FileRef,
  type PreviewInfoResponse,
} from '@wfb/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import type { Config } from '../config.js';
import { sendFile } from '../files/download.js';
import { requireUser } from '../lib/auth-context.js';
import { fileCspFor } from '../lib/security-headers.js';
import { parse } from '../lib/validate.js';
import { mimeFor } from '../storage/entries.js';
import { LocalStorageProvider } from '../storage/local.js';
import type { EntryInfo, StorageProvider } from '../storage/provider.js';
import { classify } from './kinds.js';
import { unsupported } from './limits.js';
import type { OfficeConverter } from './office.js';
import type { ThumbnailService } from './thumbnails.js';

export const MAX_TEXT_BYTES = 1024 * 1024;

export { FILE_CSP as PREVIEW_CSP, PDF_CSP } from '../lib/security-headers.js';

export interface PreviewServices {
  thumbnails: ThumbnailService;
  office: OfficeConverter;
  officeCacheDir: string;
}

export function registerPreviewRoutes(app: FastifyInstance, config: Config, svc: PreviewServices): void {
  const p = (route: string) => `${API_PREFIX}${route}`;
  const officeStore = new LocalStorageProvider(svc.officeCacheDir, {
    trashDirName: config.storage.trashDirName,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    reply.header('Content-Security-Policy', fileCspFor(type));
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    return payload;
  });

  const resolveFile = async (request: FastifyRequest, ref: FileRef) => {
    const user = requireUser(request);
    const resolved = await app.resolveRef(user, ref, 'read');
    const info = await resolved.provider.stat(resolved.virtualPath);
    const mime = info.type === 'file' ? mimeFor(info.name) : null;
    const cls = mime
      ? classify(info.name, mime, { office: svc.office.enabled })
      : { kind: 'none' as const, rasterize: false, language: null };
    return { ref: resolved, info, mime, cls };
  };

  app.get(p('/preview/info'), async (request): Promise<PreviewInfoResponse> => {
    const query = parse(PreviewInfoQuery, request.query);
    const { ref, info, mime, cls } = await resolveFile(request, query);
    const contentUrl =
      cls.kind === 'none'
        ? null
        : `${API_PREFIX}/preview/content?${new URLSearchParams({ share: ref.shareId, path: ref.virtualPath })}`;
    return {
      kind: cls.kind,
      mime,
      contentUrl,
      ...(cls.kind === 'text' ? { truncated: info.size > MAX_TEXT_BYTES, language: cls.language } : {}),
    };
  });

  app.get(p('/preview/thumbnail'), async (request, reply) => {
    const query = parse(ThumbnailQuery, request.query);
    const { ref, info, cls } = await resolveFile(request, query);
    if (cls.kind !== 'image') throw unsupported('No thumbnail available for this file type');
    const thumb = await svc.thumbnails.get(ref, info, query.size);
    return sendImage(request, reply, thumb, 'private, max-age=3600');
  });

  app.get(p('/preview/content'), async (request, reply) => {
    const query = parse(PreviewContentQuery, request.query);
    const { ref, info, mime, cls } = await resolveFile(request, query);
    if (!mime) throw unsupported('Folders cannot be previewed');
    switch (cls.kind) {
      case 'text':
        return sendText(reply, ref.provider, ref.virtualPath, info);
      case 'image':
        if (cls.rasterize) {
          const thumb = await svc.thumbnails.get(ref, info, 'large');
          return sendImage(request, reply, thumb, 'private, no-cache');
        }
        return sendFile(request, reply, { ...ref, info, mime, inline: true });
      case 'pdf':
      case 'audio':
      case 'video':
        return sendFile(request, reply, { ...ref, info, mime, inline: true });
      case 'office': {
        const name = await svc.office.toPdf(ref, info);
        const pdf = await officeStore.stat(`/${name}`);
        return sendFile(request, reply, {
          provider: officeStore,
          virtualPath: `/${name}`,
          info: { ...pdf, name: `${info.name.replace(/\.[^.]+$/, '')}.pdf` },
          mime: 'application/pdf',
          inline: true,
        });
      }
      default:
        throw unsupported('No preview available for this file type');
    }
  });
}

function sendImage(
  request: FastifyRequest,
  reply: FastifyReply,
  thumb: { file: string; etag: string; generated: boolean },
  cacheControl: string,
): FastifyReply {
  reply
    .header('ETag', thumb.etag)
    .header('Cache-Control', cacheControl)
    .header('X-Thumbnail-Cache', thumb.generated ? 'miss' : 'hit');
  const inm = request.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim() === thumb.etag)) return reply.code(304).send();
  return reply.type('image/webp').send(createReadStream(thumb.file));
}

async function sendText(
  reply: FastifyReply,
  provider: StorageProvider,
  virtualPath: string,
  info: EntryInfo,
): Promise<FastifyReply> {
  const length = Math.min(info.size, MAX_TEXT_BYTES);
  let buf: Buffer = Buffer.alloc(0);
  if (length > 0) {
    const chunks: Buffer[] = [];
    for await (const chunk of await provider.createReadStream(virtualPath, { start: 0, end: length - 1 })) {
      chunks.push(chunk as Buffer);
    }
    buf = Buffer.concat(chunks);
  }
  if (buf.includes(0)) throw unsupported('Binary file');
  const truncated = info.size > MAX_TEXT_BYTES;
  if (truncated) buf = trimPartialUtf8(buf);
  return reply
    .header('Content-Type', 'text/plain; charset=utf-8')
    .header('Cache-Control', 'private, no-cache')
    .header('X-Preview-Truncated', String(truncated))
    .send(buf);
}

/** Drops an incomplete multi-byte UTF-8 sequence left at the end by truncation. */
export function trimPartialUtf8(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i]! & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return expected > continuation + 1 ? buf.subarray(0, i) : buf;
}
