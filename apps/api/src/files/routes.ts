import {
  API_PREFIX,
  joinPath,
  DeleteRequest,
  DownloadQuery,
  FileRef,
  ListQuery,
  MkdirRequest,
  RenameRequest,
  TransferRequest,
  UploadQuery,
  type DeleteResponse,
  type EntryResponse,
  type FileEntry,
  type ListResponse,
  type SharesResponse,
  type StatResponse,
  type TransferItemResult,
  type TransferResponse,
  type UploadResponse,
} from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import { refTarget, type AuditIntent, type AuditItem } from '../audit/index.js';
import type { Config } from '../config.js';
import { requireUser } from '../lib/auth-context.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { mimeFor } from '../storage/entries.js';
import { sendFile } from './download.js';
import type { FilesService } from './service.js';
import { guardedFileStream } from './upload.js';

export function transferAuditItems(results: TransferItemResult[]): AuditItem[] {
  return results.map((r) => ({
    ...r.source,
    target: r.target ? refTarget(r.target) : null,
    outcome: r.status === 'failed' ? 'failure' : 'success',
    detail: { status: r.status, ...(r.error ? { error: r.error } : {}) },
  }));
}

export function registerFileRoutes(app: FastifyInstance, files: FilesService, config: Config): void {
  const p = (route: string) => `${API_PREFIX}${route}`;

  app.get(p('/shares'), async (request): Promise<SharesResponse> => {
    const user = requireUser(request);
    return { shares: files.shares.listForUser(user) };
  });

  app.get(p('/files'), async (request): Promise<ListResponse> => {
    const user = requireUser(request);
    return files.list(user, parse(ListQuery, request.query));
  });

  app.get(p('/files/stat'), async (request): Promise<StatResponse> => {
    const user = requireUser(request);
    return { entry: await files.stat(user, parse(FileRef, request.query)) };
  });

  app.post(p('/files/mkdir'), async (request): Promise<EntryResponse> => {
    const user = requireUser(request);
    const body = parse(MkdirRequest, request.body);
    const audit: AuditIntent = { action: 'mkdir', share: body.share, path: joinPath(body.path, body.name) };
    request.audit = audit;
    const entry = await files.mkdir(user, body);
    audit.path = entry.path;
    return { entry };
  });

  app.post(p('/files/rename'), async (request): Promise<EntryResponse> => {
    const user = requireUser(request);
    const body = parse(RenameRequest, request.body);
    const audit: AuditIntent = { action: 'rename', share: body.share, path: body.path, target: body.newName };
    request.audit = audit;
    const entry = await files.rename(user, body);
    audit.target = entry.path;
    return { entry };
  });

  for (const kind of ['copy', 'move'] as const) {
    app.post(p(`/files/${kind}`), async (request): Promise<TransferResponse> => {
      const user = requireUser(request);
      const body = parse(TransferRequest, request.body);
      const audit: AuditIntent = {
        action: kind,
        share: body.items[0]?.share,
        path: body.items[0]?.path,
        target: refTarget(body.destination),
        detail: { items: body.items.length, conflict: body.conflict },
      };
      request.audit = audit;
      const plan = await files.prepareTransfer(kind, user, body);
      const ip = request.ip;
      const onFinish = (results: TransferItemResult[], error: unknown) => {
        for (const item of transferAuditItems(results)) {
          void app.audit.record({ action: kind, user, ip, ...item, detail: { ...item.detail, mode: 'job' } });
        }
        if (error) {
          void app.audit.record({
            action: kind,
            user,
            ip,
            share: audit.share,
            path: audit.path,
            target: audit.target,
            outcome: 'failure',
            detail: { mode: 'job', error: (error as Error).message ?? 'failed' },
          });
        }
      };
      const jobId = files.jobs ? await files.jobs.maybeStart(user, plan, onFinish) : null;
      if (jobId) {
        audit.skip = true;
        return { mode: 'job', jobId };
      }
      const results = await files.runTransfer(plan);
      audit.items = transferAuditItems(results);
      return { mode: 'sync', results };
    });
  }

  app.post(p('/files/delete'), async (request): Promise<DeleteResponse> => {
    const user = requireUser(request);
    const body = parse(DeleteRequest, request.body);
    const audit: AuditIntent = {
      action: 'delete',
      share: body.items[0]?.share,
      path: body.items[0]?.path,
      detail: { items: body.items.length, permanent: body.permanent },
    };
    request.audit = audit;
    const response = await files.delete(user, body);
    audit.items = response.results.map((r) => ({
      ...r.source,
      outcome: r.status === 'failed' ? 'failure' : 'success',
      detail: { status: r.status, ...(r.error ? { error: r.error } : {}) },
    }));
    return response;
  });

  app.post(p('/files/upload'), async (request): Promise<UploadResponse> => {
    const user = requireUser(request);
    const query = parse(UploadQuery, request.query);
    if (!request.isMultipart()) throw badRequest('Expected multipart/form-data');
    const audit: AuditIntent = { action: 'upload', share: query.share, path: query.path, items: [] };
    request.audit = audit;
    const dest = await files.uploadDestination(user, query);
    const entries: FileEntry[] = [];
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      if (part.fieldname !== 'file') {
        part.file.resume();
        continue;
      }
      const stream = guardedFileStream(part, config.storage.maxUploadBytes);
      try {
        const entry = await files.writeUpload(dest, part.filename, stream, query.conflict);
        if (entry) {
          entries.push(entry);
          audit.items!.push({
            share: dest.shareId,
            path: entry.path,
            outcome: 'success',
            detail: { size: entry.size },
          });
        }
      } catch (err) {
        part.file.resume();
        throw err;
      }
    }
    return { entries };
  });

  app.get(p('/files/download'), async (request, reply) => {
    const user = requireUser(request);
    const query = parse(DownloadQuery, request.query);
    const ref = await files.resolveRef(user, query, 'read');
    const info = await ref.provider.stat(ref.virtualPath);
    return sendFile(request, reply, {
      provider: ref.provider,
      virtualPath: ref.virtualPath,
      info,
      mime: mimeFor(info.name),
      inline: query.inline ?? false,
    });
  });
}
