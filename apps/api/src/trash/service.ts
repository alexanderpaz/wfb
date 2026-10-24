import { basename, dirname, joinPath, type Permission, type TrashItem, type User } from '@wfb/contracts';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedShare } from '../acl/share-service.js';
import type { FilesService, ResolvedRef, TrashHandler } from '../files/index.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { measure } from '../jobs/transfer.js';
import { LocalStorageProvider } from '../storage/local.js';
import { freeName } from '../storage/names.js';

const META = 'meta.json';
const ITEM = 'item';
const ID_RE = /^[0-9a-z]{8,40}-[0-9a-f]{8}$/;
const DAY = 24 * 60 * 60 * 1000;

interface TrashMeta {
  originalPath: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  deletedAt: string;
  deletedBy: string;
}

export interface TrashServiceOptions {
  trashDirName: string;
  retentionMs?: number;
  /** Minimum time between automatic purges of the same share. */
  purgeCheckMs?: number;
}

async function moveEntry(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(src, dst, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
    });
    await rm(src, { recursive: true });
  }
}

/**
 * Per-share recycle bin stored in `<shareRoot>/<trashDirName>/<id>/` with the
 * entry itself (`item`) and its metadata (`meta.json`).
 */
export class TrashService implements TrashHandler {
  private readonly retentionMs: number;
  private readonly purgeCheckMs: number;
  private readonly lastPurge = new Map<string, number>();

  constructor(
    private readonly files: FilesService,
    private readonly opts: TrashServiceOptions,
  ) {
    this.retentionMs = opts.retentionMs ?? 30 * DAY;
    this.purgeCheckMs = opts.purgeCheckMs ?? 10 * 60 * 1000;
  }

  private async trashDir(share: ResolvedShare): Promise<string> {
    return path.join(await realpath(share.path), this.opts.trashDirName);
  }

  private provider(share: ResolvedShare): LocalStorageProvider {
    const provider = this.files.providerFor(share);
    if (!(provider instanceof LocalStorageProvider)) throw new Error('Only local storage is supported');
    return provider;
  }

  async trash(user: User, ref: ResolvedRef): Promise<void> {
    const provider = this.provider(ref.share);
    const entry = await provider.entryPath(ref.virtualPath);
    const st = await lstat(entry);
    const size = st.isDirectory()
      ? (await measure(entry, { maxBytes: Infinity, maxEntries: 100_000 }, undefined, false)).bytes
      : st.size;
    const meta: TrashMeta = {
      originalPath: ref.virtualPath,
      name: basename(ref.virtualPath),
      type: st.isDirectory() ? 'directory' : 'file',
      size,
      deletedAt: new Date().toISOString(),
      deletedBy: user.username,
    };
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const dir = path.join(await this.trashDir(ref.share), id);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(path.join(dir, META), JSON.stringify(meta));
      await moveEntry(entry, path.join(dir, ITEM));
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    void this.autoPurge(ref.share);
  }

  private async readMeta(dir: string): Promise<TrashMeta | null> {
    try {
      const meta = JSON.parse(await readFile(path.join(dir, META), 'utf8')) as TrashMeta;
      return typeof meta.originalPath === 'string' && typeof meta.deletedAt === 'string' ? meta : null;
    } catch {
      return null;
    }
  }

  private async items(share: ResolvedShare): Promise<TrashItem[]> {
    const root = await this.trashDir(share);
    let ids: string[];
    try {
      ids = (await readdir(root)).filter((n) => ID_RE.test(n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const items = await Promise.all(
      ids.map(async (id): Promise<TrashItem | null> => {
        const meta = await this.readMeta(path.join(root, id));
        if (!meta) return null;
        return {
          id,
          share: share.id,
          originalPath: meta.originalPath,
          name: meta.name,
          type: meta.type === 'directory' ? 'directory' : 'file',
          size: Math.max(0, Math.floor(meta.size) || 0),
          deletedAt: meta.deletedAt,
          deletedBy: meta.deletedBy ?? '',
        };
      }),
    );
    return items
      .filter((i): i is TrashItem => i !== null)
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /** Removes entries older than the retention period (at most once per `purgeCheckMs` per share). */
  async autoPurge(share: ResolvedShare, force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - (this.lastPurge.get(share.path) ?? 0) < this.purgeCheckMs) return 0;
    this.lastPurge.set(share.path, now);
    const root = await this.trashDir(share);
    const expired = (await this.items(share)).filter((i) => now - Date.parse(i.deletedAt) > this.retentionMs);
    await Promise.all(expired.map((i) => rm(path.join(root, i.id), { recursive: true, force: true })));
    return expired.length;
  }

  /**
   * Access policy. The trash of a share is shared by everyone entitled to act
   * on it, whoever deleted the item (`deletedBy` is informative):
   * - list: read + (write or delete)
   * - restore: read + write
   * - purge: read + delete
   * Read is always required so write-only shares (drop boxes) never reveal
   * names of deleted entries. Invisible shares are 404, missing permissions 403.
   */
  private async access(user: User, shareId: string, need: 'list' | Permission): Promise<ResolvedShare> {
    const share = await this.files.shares.assert(user, shareId, 'read');
    const perms = share.permissions;
    const ok = need === 'list' ? perms.includes('write') || perms.includes('delete') : perms.includes(need);
    if (!ok)
      throw forbidden(need === 'list' ? 'Missing permission on this trash' : `Missing "${need}" permission`);
    return share;
  }

  async list(user: User, shareId: string): Promise<TrashItem[]> {
    const share = await this.access(user, shareId, 'list');
    await this.autoPurge(share).catch(() => 0);
    return this.items(share);
  }

  private checkIds(ids: string[]) {
    for (const id of ids) if (!ID_RE.test(id)) throw badRequest('Invalid trash id', { id });
  }

  /** Returns where each item went back to (after conflict renaming). */
  async restore(user: User, shareId: string, ids: string[]): Promise<{ id: string; path: string }[]> {
    this.checkIds(ids);
    const share = await this.access(user, shareId, 'write');
    const provider = this.provider(share);
    const root = await this.trashDir(share);
    const metas = await Promise.all(ids.map((id) => this.readMeta(path.join(root, id))));
    const missing = ids.filter((_, i) => !metas[i]);
    if (missing.length) throw notFound('Trash item not found');
    const restored: { id: string; path: string }[] = [];

    for (const [i, id] of ids.entries()) {
      const meta = metas[i]!;
      const parent = dirname(meta.originalPath);
      await mkdir(await provider.realPath(parent), { recursive: true });
      const name = (await provider.exists(meta.originalPath))
        ? await freeName(meta.name, meta.type === 'directory', (c) => provider.exists(joinPath(parent, c)))
        : meta.name;
      const target = await provider.entryPath(joinPath(parent, name));
      await moveEntry(path.join(root, id, ITEM), target);
      await rm(path.join(root, id), { recursive: true, force: true });
      restored.push({ id, path: joinPath(parent, name) });
    }
    return restored;
  }

  /** Returns the original path of each purged item (null for unknown ids). */
  async purge(user: User, shareId: string, ids: string[]): Promise<{ id: string; path: string | null }[]> {
    this.checkIds(ids);
    const share = await this.access(user, shareId, 'delete');
    const root = await this.trashDir(share);
    return Promise.all(
      ids.map(async (id) => {
        const meta = await this.readMeta(path.join(root, id));
        await rm(path.join(root, id), { recursive: true, force: true });
        return { id, path: meta?.originalPath ?? null };
      }),
    );
  }
}
