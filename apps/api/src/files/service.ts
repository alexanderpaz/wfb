import {
  basename,
  dirname,
  joinPath,
  normalizeVirtualPath,
  type ConflictStrategy,
  type DeleteRequest,
  type DeleteResponse,
  type FileEntry,
  type FileRef,
  type ListResponse,
  type MkdirRequest,
  type Permission,
  type RenameRequest,
  type TransferItemResult,
  type TransferRequest,
  type User,
} from '@wfb/contracts';
import path from 'node:path';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import type { ResolvedShare, ShareService } from '../acl/share-service.js';
import { badRequest, conflict, HttpError } from '../lib/errors.js';
import { compareEntries, toFileEntry } from '../storage/entries.js';
import { LocalStorageProvider } from '../storage/local.js';
import { freeName, sanitizeFileName } from '../storage/names.js';
import type { EntryInfo, StorageProvider } from '../storage/provider.js';

export interface ResolvedRef {
  shareId: string;
  share: ResolvedShare;
  provider: StorageProvider;
  /** Absolute on-disk location, symlinks resolved and verified inside the share. */
  absPath: string;
  /** Normalized virtual path inside the share. */
  virtualPath: string;
}

/** Hook used by POST /files/delete when `permanent` is false. Without it entries are deleted. */
export interface TrashHandler {
  trash(user: User, ref: ResolvedRef): Promise<void>;
}

export interface FilesServiceOptions {
  trashDirName: string;
  officePreview: boolean;
}

type TransferInput = z.output<typeof TransferRequest>;
type DeleteInput = z.output<typeof DeleteRequest>;

/** Short machine-friendly error for per-item results. */
export function itemError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.code === 'CONFLICT') return 'exists';
    if (err.code === 'NOT_FOUND') return 'not_found';
    if (err.code === 'FORBIDDEN') return 'forbidden';
    return err.message;
  }
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      return 'not_found';
    case 'EEXIST':
    case 'ENOTEMPTY':
      return 'exists';
    case 'EACCES':
    case 'EPERM':
      return 'forbidden';
    default:
      return (err as Error).message ?? 'failed';
  }
}

export class FilesService {
  private readonly providers = new Map<string, LocalStorageProvider>();
  trash: TrashHandler | null = null;

  constructor(
    readonly shares: ShareService,
    private readonly opts: FilesServiceOptions,
  ) {}

  providerFor(share: ResolvedShare): StorageProvider {
    let provider = this.providers.get(share.path);
    if (!provider) {
      provider = new LocalStorageProvider(share.path, { trashDirName: this.opts.trashDirName });
      this.providers.set(share.path, provider);
    }
    return provider;
  }

  async resolveRef(user: User, ref: FileRef, perm: Permission): Promise<ResolvedRef> {
    const virtualPath = normalizeVirtualPath(ref.path);
    if (virtualPath === null) throw badRequest('Invalid path');
    const share = await this.shares.assert(user, ref.share, perm);
    const provider = this.providerFor(share);
    const absPath = await provider.realPath(virtualPath);
    return { shareId: share.id, share, provider, absPath, virtualPath };
  }

  toEntry(share: ResolvedShare, info: EntryInfo): FileEntry {
    const named = info.path === '/' ? { ...info, name: share.name } : info;
    return toFileEntry(named, { office: this.opts.officePreview });
  }

  async list(user: User, ref: FileRef): Promise<ListResponse> {
    const r = await this.resolveRef(user, ref, 'read');
    const infos = await r.provider.list(r.virtualPath);
    const entries = infos.map((i) => this.toEntry(r.share, i)).sort(compareEntries);
    return { share: r.shareId, path: r.virtualPath, entries };
  }

  async stat(user: User, ref: FileRef): Promise<FileEntry> {
    const r = await this.resolveRef(user, ref, 'read');
    return this.toEntry(r.share, await r.provider.stat(r.virtualPath));
  }

  async mkdir(user: User, req: MkdirRequest): Promise<FileEntry> {
    const r = await this.resolveRef(user, req, 'write');
    return this.toEntry(r.share, await r.provider.mkdir(r.virtualPath, req.name));
  }

  async rename(user: User, req: RenameRequest): Promise<FileEntry> {
    const r = await this.resolveRef(user, req, 'write');
    if (r.virtualPath === '/') throw badRequest('The share root cannot be renamed');
    return this.toEntry(r.share, await r.provider.rename(r.virtualPath, req.newName));
  }

  private async destinationFolder(user: User, ref: FileRef, perm: Permission): Promise<ResolvedRef> {
    const dest = await this.resolveRef(user, ref, perm);
    const info = await dest.provider.stat(dest.virtualPath);
    if (info.type !== 'directory') throw badRequest('Destination is not a folder');
    return dest;
  }

  /**
   * Synchronous copy/move. Permissions and structural errors (root, into
   * itself) fail the whole request; file system errors are reported per item.
   */
  async transfer(kind: 'copy' | 'move', user: User, req: TransferInput): Promise<TransferItemResult[]> {
    const dest = await this.destinationFolder(user, req.destination, 'write');
    const sources: ResolvedRef[] = [];
    for (const item of req.items) {
      const src = await this.resolveRef(user, item, 'read');
      if (kind === 'move') await this.shares.assert(user, item.share, 'delete');
      if (src.virtualPath === '/') throw badRequest(`Cannot ${kind} a share root`);
      if (dest.absPath === src.absPath || dest.absPath.startsWith(src.absPath + path.sep)) {
        throw badRequest(`Cannot ${kind} a folder into itself`, { source: item });
      }
      sources.push(src);
    }

    const results: TransferItemResult[] = [];
    for (const src of sources) {
      const source = { share: src.shareId, path: src.virtualPath };
      try {
        results.push(await this.transferOne(kind, src, dest, req.conflict));
      } catch (err) {
        results.push({ source, status: 'failed', target: null, error: itemError(err) });
      }
    }

    if (req.conflict === 'fail' && results.every((r) => r.status === 'failed' && r.error === 'exists')) {
      throw conflict('Some entries already exist at the destination', {
        conflicts: results.map((r) => ({
          name: basename(r.source.path),
          source: r.source,
          target: { share: dest.shareId, path: joinPath(dest.virtualPath, basename(r.source.path)) },
        })),
      });
    }
    return results;
  }

  private async transferOne(
    kind: 'copy' | 'move',
    src: ResolvedRef,
    dest: ResolvedRef,
    strategy: ConflictStrategy,
  ): Promise<TransferItemResult> {
    const source = { share: src.shareId, path: src.virtualPath };
    const info = await src.provider.stat(src.virtualPath);
    const name = basename(src.virtualPath);
    const sameLocation =
      (src.shareId === dest.shareId && dirname(src.virtualPath) === dest.virtualPath) ||
      (path.dirname(src.absPath) === dest.absPath && path.basename(src.absPath) === name);

    if (kind === 'move' && sameLocation) return { source, status: 'skipped', target: source, error: null };

    let targetName = name;
    let targetPath = joinPath(dest.virtualPath, targetName);
    if (sameLocation || (await dest.provider.exists(targetPath))) {
      switch (strategy) {
        case 'fail':
          return { source, status: 'failed', target: null, error: 'exists' };
        case 'skip':
          return { source, status: 'skipped', target: null, error: null };
        case 'rename':
          targetName = await freeName(name, info.type === 'directory', (c) =>
            dest.provider.exists(joinPath(dest.virtualPath, c)),
          );
          targetPath = joinPath(dest.virtualPath, targetName);
          break;
        case 'overwrite': {
          if (sameLocation) return { source, status: 'skipped', target: source, error: null };
          const existingAbs = await dest.provider.realPath(targetPath);
          if (src.absPath.startsWith(existingAbs + path.sep)) {
            return { source, status: 'failed', target: null, error: 'Target contains the source' };
          }
          await dest.provider.remove(targetPath);
          break;
        }
      }
    }

    await src.provider[kind](src.virtualPath, { provider: dest.provider, path: targetPath });
    return { source, status: 'done', target: { share: dest.shareId, path: targetPath }, error: null };
  }

  async delete(user: User, req: DeleteInput): Promise<DeleteResponse> {
    const targets: ResolvedRef[] = [];
    for (const item of req.items) {
      const r = await this.resolveRef(user, item, 'delete');
      if (r.virtualPath === '/') throw badRequest('The share root cannot be deleted');
      targets.push(r);
    }
    const results: DeleteResponse['results'] = [];
    for (const r of targets) {
      const source = { share: r.shareId, path: r.virtualPath };
      try {
        if (!req.permanent && this.trash) {
          await this.trash.trash(user, r);
          results.push({ source, status: 'trashed', error: null });
        } else {
          await r.provider.remove(r.virtualPath);
          results.push({ source, status: 'deleted', error: null });
        }
      } catch (err) {
        results.push({ source, status: 'failed', error: itemError(err) });
      }
    }
    return { results };
  }

  /** Opens the upload destination folder (write permission). */
  uploadDestination(user: User, ref: FileRef): Promise<ResolvedRef> {
    return this.destinationFolder(user, ref, 'write');
  }

  /**
   * Stores one uploaded stream in `dest`. Returns null when skipped. The
   * stream is always consumed so multipart parsing can continue.
   */
  async writeUpload(
    dest: ResolvedRef,
    rawName: string,
    stream: Readable,
    strategy: ConflictStrategy,
  ): Promise<FileEntry | null> {
    const name = sanitizeFileName(rawName);
    if (!name) throw badRequest('Invalid file name', { name: rawName });
    let target = joinPath(dest.virtualPath, name);
    let overwrite = false;
    if (await dest.provider.exists(target)) {
      switch (strategy) {
        case 'fail':
          throw conflict('An entry with that name already exists', { conflicts: [{ name }] });
        case 'skip':
          await pipeline(stream, new Writable({ write: (_chunk, _enc, cb) => cb() }));
          return null;
        case 'rename':
          target = joinPath(
            dest.virtualPath,
            await freeName(name, false, (c) => dest.provider.exists(joinPath(dest.virtualPath, c))),
          );
          break;
        case 'overwrite':
          overwrite = true;
          break;
      }
    }
    return this.toEntry(dest.share, await dest.provider.writeFile(target, stream, { overwrite }));
  }
}
