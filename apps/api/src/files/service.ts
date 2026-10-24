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
import { badRequest, conflict, HttpError, publicErrorMessage } from '../lib/errors.js';
import { compareEntries, toFileEntry } from '../storage/entries.js';
import { LocalStorageProvider } from '../storage/local.js';
import { freeName, sanitizeFileName } from '../storage/names.js';
import type { EntryInfo, StorageProvider, TransferTarget } from '../storage/provider.js';

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

export interface TransferPlan {
  kind: 'copy' | 'move';
  dest: ResolvedRef;
  sources: ResolvedRef[];
  conflict: ConflictStrategy;
}

/** Performs the actual copy/move of one item once the target path is known to be free. */
export type TransferExecutor = (
  kind: 'copy' | 'move',
  src: ResolvedRef,
  target: TransferTarget,
) => Promise<void>;

/** Hook used by POST /files/copy|move to run large transfers as background jobs. */
export interface TransferJobHandler {
  /**
   * Returns a job id when the transfer runs in the background, null to run it
   * synchronously. `onFinish` is called once a started job ends, with the
   * per-item results so far and the error that stopped it (if any).
   */
  maybeStart(
    user: User,
    plan: TransferPlan,
    onFinish?: (results: TransferItemResult[], error: unknown) => void,
  ): Promise<string | null>;
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
      return publicErrorMessage(err);
  }
}

export class FilesService {
  private readonly providers = new Map<string, LocalStorageProvider>();
  trash: TrashHandler | null = null;
  jobs: TransferJobHandler | null = null;

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
   * Checks permissions and structural errors (root, into itself) for a
   * copy/move; these fail the whole request.
   */
  async prepareTransfer(kind: 'copy' | 'move', user: User, req: TransferInput): Promise<TransferPlan> {
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
    return { kind, dest, sources, conflict: req.conflict };
  }

  private conflictError(plan: TransferPlan, sources: FileRef[]): HttpError {
    return conflict('Some entries already exist at the destination', {
      conflicts: sources.map((source) => ({
        name: basename(source.path),
        source,
        target: { share: plan.dest.shareId, path: joinPath(plan.dest.virtualPath, basename(source.path)) },
      })),
    });
  }

  /**
   * Upfront version of the "every item conflicts" 409 for transfers that run
   * as background jobs (the synchronous path detects it after trying).
   */
  async assertNotAllConflicting(plan: TransferPlan): Promise<void> {
    if (plan.conflict !== 'fail') return;
    for (const src of plan.sources) {
      const name = basename(src.virtualPath);
      const sameParent =
        src.shareId === plan.dest.shareId && dirname(src.virtualPath) === plan.dest.virtualPath;
      if (plan.kind === 'move' && sameParent) return;
      if (!sameParent && !(await plan.dest.provider.exists(joinPath(plan.dest.virtualPath, name)))) return;
    }
    throw this.conflictError(
      plan,
      plan.sources.map((s) => ({ share: s.shareId, path: s.virtualPath })),
    );
  }

  /**
   * Synchronous copy/move. Permissions and structural errors (root, into
   * itself) fail the whole request; file system errors are reported per item.
   */
  async transfer(kind: 'copy' | 'move', user: User, req: TransferInput): Promise<TransferItemResult[]> {
    return this.runTransfer(await this.prepareTransfer(kind, user, req));
  }

  async runTransfer(plan: TransferPlan): Promise<TransferItemResult[]> {
    const results: TransferItemResult[] = [];
    for (const src of plan.sources) {
      results.push(await this.transferItem(plan.kind, src, plan.dest, plan.conflict));
    }
    if (plan.conflict === 'fail' && results.every((r) => r.status === 'failed' && r.error === 'exists')) {
      throw this.conflictError(
        plan,
        results.map((r) => r.source),
      );
    }
    return results;
  }

  /**
   * Transfers one source applying the conflict strategy. File system errors
   * become a `failed` result; `exec` replaces the provider copy/move (jobs use
   * it to report progress). Errors thrown by `exec` with `rethrow` set (e.g.
   * cancellation) propagate.
   */
  async transferItem(
    kind: 'copy' | 'move',
    src: ResolvedRef,
    dest: ResolvedRef,
    strategy: ConflictStrategy,
    exec?: TransferExecutor,
    rethrow?: (err: unknown) => boolean,
  ): Promise<TransferItemResult> {
    try {
      return await this.transferOne(kind, src, dest, strategy, exec);
    } catch (err) {
      if (rethrow?.(err)) throw err;
      const source = { share: src.shareId, path: src.virtualPath };
      return { source, status: 'failed', target: null, error: itemError(err) };
    }
  }

  private async transferOne(
    kind: 'copy' | 'move',
    src: ResolvedRef,
    dest: ResolvedRef,
    strategy: ConflictStrategy,
    exec?: TransferExecutor,
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

    const target = { provider: dest.provider, path: targetPath };
    if (exec) await exec(kind, src, target);
    else await src.provider[kind](src.virtualPath, target);
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
