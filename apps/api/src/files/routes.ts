import {
  API_PREFIX,
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
  type TransferResponse,
  type UploadResponse,
} from '@wfb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { requireUser } from '../lib/auth-context.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { mimeFor } from '../storage/entries.js';
import { sendFile } from './download.js';
import type { FilesService } from './service.js';
import { guardedFileStream } from './upload.js';

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
    return { entry: await files.mkdir(user, parse(MkdirRequest, request.body)) };
  });

  app.post(p('/files/rename'), async (request): Promise<EntryResponse> => {
    const user = requireUser(request);
    return { entry: await files.rename(user, parse(RenameRequest, request.body)) };
  });

  for (const kind of ['copy', 'move'] as const) {
    app.post(p(`/files/${kind}`), async (request): Promise<TransferResponse> => {
      const user = requireUser(request);
      const results = await files.transfer(kind, user, parse(TransferRequest, request.body));
      return { mode: 'sync', results };
    });
  }

  app.post(p('/files/delete'), async (request): Promise<DeleteResponse> => {
    const user = requireUser(request);
    return files.delete(user, parse(DeleteRequest, request.body));
  });

  app.post(p('/files/upload'), async (request): Promise<UploadResponse> => {
    const user = requireUser(request);
    const query = parse(UploadQuery, request.query);
    if (!request.isMultipart()) throw badRequest('Expected multipart/form-data');
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
        if (entry) entries.push(entry);
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
