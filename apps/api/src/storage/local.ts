import { basename, dirname, joinPath, normalizeVirtualPath, pathSegments } from '@wfb/contracts';
import { randomBytes } from 'node:crypto';
import { createWriteStream, type Stats } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { EntryInfo, StorageProvider, TransferTarget } from './provider.js';

const TEMP_PREFIX = '.wfb-upload-';
const TEMP_RE = /^\.wfb-upload-[0-9a-f]{16}\.tmp$/;

const isMissing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const CP_OPTIONS = {
  recursive: true,
  errorOnExist: true,
  force: false,
  verbatimSymlinks: true,
  preserveTimestamps: true,
} as const;

export interface LocalStorageOptions {
  /** Name of the per-share trash folder: hidden and never reachable through the API. */
  trashDirName: string;
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local';
  private rootReal: string | null = null;
  private readonly trashName: string;

  constructor(
    readonly root: string,
    opts: LocalStorageOptions,
  ) {
    this.trashName = opts.trashDirName.toLowerCase();
  }

  /** Names never listed nor addressable: the trash folder and in-flight upload temp files. */
  isHiddenName(name: string): boolean {
    return name.toLowerCase() === this.trashName || TEMP_RE.test(name);
  }

  /** Validates a single new entry name (mkdir, rename, upload, transfer target). */
  assertValidName(name: string): void {
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name) || Buffer.byteLength(name) > 255) {
      throw badRequest('Invalid file name');
    }
    if (this.isHiddenName(name)) throw badRequest('Reserved file name');
  }

  private async getRoot(): Promise<string> {
    if (!this.rootReal) {
      try {
        this.rootReal = await realpath(this.root);
      } catch (err) {
        if (isMissing(err)) throw notFound('Share folder is not available');
        throw err;
      }
    }
    return this.rootReal;
  }

  private segments(virtualPath: string): string[] {
    const normalized = normalizeVirtualPath(virtualPath);
    if (normalized === null) throw badRequest('Invalid path');
    const segs = pathSegments(normalized);
    if (segs.some((s) => this.isHiddenName(s))) throw notFound('File or folder not found');
    return segs;
  }

  private assertInside(root: string, real: string): void {
    if (real !== root && !real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      throw forbidden('Path resolves outside the share');
    }
  }

  /**
   * Resolves symlinks of the deepest existing ancestor and verifies it stays
   * inside the share root. Missing trailing segments are appended verbatim.
   */
  async realPath(virtualPath: string): Promise<string> {
    const root = await this.getRoot();
    const segs = this.segments(virtualPath);
    for (let i = segs.length; i >= 0; i--) {
      const candidate = path.join(root, ...segs.slice(0, i));
      let real: string;
      try {
        real = await realpath(candidate);
      } catch (err) {
        if (!isMissing(err) || i === 0) throw err;
        // A dangling symlink could later be pointed anywhere: refuse to go through it.
        const isLink = await lstat(candidate).then(
          (st) => st.isSymbolicLink(),
          () => false,
        );
        if (isLink) throw notFound('File or folder not found');
        continue;
      }
      this.assertInside(root, real);
      return path.join(real, ...segs.slice(i));
    }
    return root;
  }

  /**
   * Location of the entry itself (symlinks not followed for the last segment),
   * for operations that act on the entry: rename, move, delete, write.
   */
  async entryPath(virtualPath: string): Promise<string> {
    const segs = this.segments(virtualPath);
    if (segs.length === 0) throw badRequest('This operation is not allowed on the share root');
    const parent = await this.realPath('/' + segs.slice(0, -1).join('/'));
    return path.join(parent, segs[segs.length - 1]!);
  }

  private info(virtualPath: string, st: Stats): EntryInfo {
    const normalized = normalizeVirtualPath(virtualPath) ?? '/';
    return {
      name: basename(normalized),
      path: normalized,
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      modifiedAt: st.mtime,
    };
  }

  async list(dir: string): Promise<EntryInfo[]> {
    const root = await this.getRoot();
    const abs = await this.realPath(dir);
    const base = normalizeVirtualPath(dir) ?? '/';
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d): Promise<EntryInfo | null> => {
        if (this.isHiddenName(d.name)) return null;
        const full = path.join(abs, d.name);
        try {
          if (d.isSymbolicLink()) this.assertInside(root, await realpath(full));
          const st = await stat(full);
          if (!st.isFile() && !st.isDirectory()) return null;
          return this.info(joinPath(base, d.name), st);
        } catch {
          // Escaping or dangling symlinks and entries removed mid-listing are skipped.
          return null;
        }
      }),
    );
    return entries.filter((e): e is EntryInfo => e !== null);
  }

  async stat(virtualPath: string): Promise<EntryInfo> {
    const st = await stat(await this.realPath(virtualPath));
    if (!st.isFile() && !st.isDirectory()) throw badRequest('Unsupported file type');
    return this.info(virtualPath, st);
  }

  async exists(virtualPath: string): Promise<boolean> {
    if (this.segments(virtualPath).length === 0) return true;
    try {
      await lstat(await this.entryPath(virtualPath));
      return true;
    } catch (err) {
      if (isMissing(err) || (err as { code?: string }).code === 'NOT_FOUND') return false;
      throw err;
    }
  }

  async mkdir(dir: string, name: string): Promise<EntryInfo> {
    this.assertValidName(name);
    const target = joinPath(normalizeVirtualPath(dir) ?? '/', name);
    await mkdir(path.join(await this.realPath(dir), name));
    return this.stat(target);
  }

  async rename(virtualPath: string, newName: string): Promise<EntryInfo> {
    this.assertValidName(newName);
    const src = await this.entryPath(virtualPath);
    const normalized = normalizeVirtualPath(virtualPath)!;
    const target = joinPath(dirname(normalized), newName);
    const srcStat = await lstat(src);
    if (basename(normalized) === newName) return this.stat(target);
    const dst = path.join(path.dirname(src), newName);
    const existing = await lstat(dst).catch(() => null);
    // Same inode means a case-only rename on a case-insensitive file system.
    if (existing && !(existing.ino === srcStat.ino && existing.dev === srcStat.dev)) {
      throw conflict('An entry with that name already exists', { conflicts: [newName] });
    }
    await rename(src, dst);
    return this.stat(target);
  }

  private async targetPath(target: TransferTarget): Promise<string> {
    if (!(target.provider instanceof LocalStorageProvider)) {
      throw new Error(`Transfers from local storage to "${target.provider.kind}" are not supported`);
    }
    target.provider.assertValidName(basename(normalizeVirtualPath(target.path) ?? ''));
    const dst = await target.provider.entryPath(target.path);
    if (
      await lstat(dst).then(
        () => true,
        () => false,
      )
    ) {
      throw conflict('An entry with that name already exists');
    }
    return dst;
  }

  private assertNotInto(src: string, dst: string) {
    if (dst === src || dst.startsWith(src + path.sep)) {
      throw badRequest('Cannot copy or move a folder into itself');
    }
  }

  async copy(src: string, target: TransferTarget): Promise<void> {
    if (this.segments(src).length === 0) throw badRequest('This operation is not allowed on the share root');
    const srcAbs = await this.realPath(src);
    await lstat(srcAbs);
    const dst = await this.targetPath(target);
    this.assertNotInto(srcAbs, dst);
    try {
      await cp(srcAbs, dst, CP_OPTIONS);
    } catch (err) {
      await rm(dst, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async move(src: string, target: TransferTarget): Promise<void> {
    const srcAbs = await this.entryPath(src);
    const srcStat = await lstat(srcAbs);
    const dst = await this.targetPath(target);
    if (srcStat.isDirectory()) this.assertNotInto(srcAbs, dst);
    try {
      await rename(srcAbs, dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      try {
        await cp(srcAbs, dst, CP_OPTIONS);
      } catch (copyErr) {
        await rm(dst, { recursive: true, force: true }).catch(() => {});
        throw copyErr;
      }
      await rm(srcAbs, { recursive: true });
    }
  }

  async remove(virtualPath: string): Promise<void> {
    const abs = await this.entryPath(virtualPath);
    await lstat(abs);
    await rm(abs, { recursive: true });
  }

  async createReadStream(virtualPath: string, range?: { start?: number; end?: number }): Promise<Readable> {
    const handle = await open(await this.realPath(virtualPath), 'r');
    return handle.createReadStream({ start: range?.start, end: range?.end });
  }

  async writeFile(
    virtualPath: string,
    data: Readable,
    opts: { overwrite?: boolean } = {},
  ): Promise<EntryInfo> {
    const dst = await this.entryPath(virtualPath);
    this.assertValidName(path.basename(dst));
    const temp = path.join(path.dirname(dst), `${TEMP_PREFIX}${randomBytes(8).toString('hex')}.tmp`);
    try {
      await pipeline(data, createWriteStream(temp, { flags: 'wx' }));
      const existing = await lstat(dst).catch(() => null);
      if (existing && !opts.overwrite) throw conflict('An entry with that name already exists');
      if (existing?.isDirectory()) await rm(dst, { recursive: true });
      await rename(temp, dst);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    return this.stat(virtualPath);
  }
}
