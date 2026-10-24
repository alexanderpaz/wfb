import { basename, joinPath, type User } from '@wfb/contracts';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rename, rm, stat, symlink, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FilesService, ResolvedRef, TransferJobHandler, TransferPlan } from '../files/index.js';
import { conflict } from '../lib/errors.js';
import { LocalStorageProvider } from '../storage/local.js';
import type { TransferTarget } from '../storage/provider.js';
import { CancelledError, type JobContext, type JobManager } from './manager.js';

export interface WalkLimits {
  maxBytes: number;
  maxEntries: number;
  signal?: AbortSignal;
}

export interface SizeEstimate {
  bytes: number;
  entries: number;
  /** True when the walk stopped early because a limit was exceeded. */
  exceeded: boolean;
}

function local(provider: unknown): LocalStorageProvider {
  if (!(provider instanceof LocalStorageProvider)) throw new Error('Only local storage is supported');
  return provider;
}

/**
 * Bytes and entries below `abs` (symlinks are counted, not followed). Stops as
 * soon as a limit is exceeded so large trees are not walked synchronously.
 */
export async function measure(
  abs: string,
  limits: WalkLimits,
  acc: SizeEstimate = { bytes: 0, entries: 0, exceeded: false },
  follow = true,
): Promise<SizeEstimate> {
  if (acc.exceeded) return acc;
  if (limits.signal?.aborted) throw new CancelledError();
  const st = await (follow ? stat(abs) : lstat(abs));
  acc.entries++;
  if (st.isFile()) acc.bytes += st.size;
  if (acc.bytes > limits.maxBytes || acc.entries > limits.maxEntries) {
    acc.exceeded = true;
    return acc;
  }
  if (st.isDirectory()) {
    for (const name of await readdir(abs)) {
      await measure(path.join(abs, name), limits, acc, false);
      if (acc.exceeded) break;
    }
  }
  return acc;
}

const tempName = () => `.wfb-upload-${randomBytes(8).toString('hex')}.tmp`;

export interface CopyProgress {
  signal: AbortSignal;
  onBytes(n: number): void;
  onFile(relPath: string): void;
  isHidden(name: string): boolean;
}

/** Streams one file into a hidden temp file next to `dst`, then renames it into place. */
async function copyFile(src: string, dst: string, progress: CopyProgress): Promise<void> {
  const st = await stat(src);
  const temp = path.join(path.dirname(dst), tempName());
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (progress.signal.aborted) return cb(new CancelledError());
      progress.onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(src, { highWaterMark: 256 * 1024 }),
      counter,
      createWriteStream(temp, { flags: 'wx' }),
      {
        signal: progress.signal,
      },
    );
    await utimes(temp, st.atime, st.mtime).catch(() => {});
    await rename(temp, dst);
  } catch (err) {
    await unlink(temp).catch(() => {});
    if (progress.signal.aborted) throw new CancelledError();
    throw err;
  }
}

/** Recursive copy reporting progress. Symlinks inside the tree are copied as links (like `cp`). */
export async function copyTree(
  src: string,
  dst: string,
  rel: string,
  progress: CopyProgress,
  follow = true,
): Promise<void> {
  if (progress.signal.aborted) throw new CancelledError();
  const st = await (follow ? stat(src) : lstat(src));
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dst);
  } else if (st.isDirectory()) {
    await mkdir(dst);
    for (const name of await readdir(src)) {
      if (progress.isHidden(name)) continue;
      await copyTree(path.join(src, name), path.join(dst, name), joinPath(rel, name), progress, false);
    }
    await utimes(dst, st.atime, st.mtime).catch(() => {});
  } else if (st.isFile()) {
    progress.onFile(rel);
    await copyFile(src, dst, progress);
  }
}

async function freeTarget(target: TransferTarget): Promise<string> {
  const provider = local(target.provider);
  provider.assertValidName(basename(target.path));
  const dst = await provider.entryPath(target.path);
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

export interface TransferJobsOptions {
  syncLimitBytes: number;
  syncLimitEntries?: number;
  /** Minimum interval between byte progress updates. */
  progressIntervalMs?: number;
}

/** Decides between sync and job mode and runs large copy/move operations as jobs. */
export class TransferJobs implements TransferJobHandler {
  private readonly maxEntries: number;
  private readonly progressIntervalMs: number;

  constructor(
    private readonly files: FilesService,
    private readonly manager: JobManager,
    private readonly opts: TransferJobsOptions,
  ) {
    this.maxEntries = opts.syncLimitEntries ?? 1000;
    this.progressIntervalMs = opts.progressIntervalMs ?? 100;
  }

  /** Rename-only moves cost nothing regardless of size. */
  private async isCheapMove(src: ResolvedRef, dest: ResolvedRef): Promise<boolean> {
    try {
      const entry = await local(src.provider).entryPath(src.virtualPath);
      const [a, b] = await Promise.all([lstat(entry), stat(dest.absPath)]);
      return a.dev === b.dev;
    } catch {
      return false;
    }
  }

  async maybeStart(user: User, plan: TransferPlan): Promise<string | null> {
    const acc: SizeEstimate = { bytes: 0, entries: 0, exceeded: false };
    for (const src of plan.sources) {
      if (plan.kind === 'move' && (await this.isCheapMove(src, plan.dest))) continue;
      try {
        await measure(src.absPath, { maxBytes: this.opts.syncLimitBytes, maxEntries: this.maxEntries }, acc);
      } catch {
        // Missing sources are reported per item by the transfer itself.
      }
      if (acc.exceeded) break;
    }
    if (!acc.exceeded) return null;
    await this.files.assertNotAllConflicting(plan);
    const job = this.manager.start(
      user.id,
      { kind: plan.kind, totalBytes: acc.bytes, totalItems: plan.sources.length },
      (ctx) => this.run(plan, ctx),
    );
    return job.id;
  }

  private async run(plan: TransferPlan, ctx: JobContext): Promise<void> {
    const sizes: number[] = [];
    for (const src of plan.sources) {
      const cheap = plan.kind === 'move' && (await this.isCheapMove(src, plan.dest));
      const m = await measure(src.absPath, {
        maxBytes: Infinity,
        maxEntries: Infinity,
        signal: ctx.signal,
      }).catch((err) => {
        if (err instanceof CancelledError) throw err;
        return { bytes: 0 };
      });
      sizes.push(cheap ? 0 : m.bytes);
    }
    let doneBytes = 0;
    ctx.update({ totalBytes: sizes.reduce((a, b) => a + b, 0) });

    let lastEmit = 0;
    const progress = (src: ResolvedRef): CopyProgress => ({
      signal: ctx.signal,
      isHidden: (name) => local(src.provider).isHiddenName(name),
      onBytes: (n) => {
        doneBytes += n;
        const now = Date.now();
        if (now - lastEmit >= this.progressIntervalMs) {
          lastEmit = now;
          ctx.update({ doneBytes });
        }
      },
      onFile: (rel) => ctx.update({ currentItem: joinPath(src.virtualPath, rel.slice(1)), doneBytes }),
    });

    const exec = async (kind: 'copy' | 'move', src: ResolvedRef, target: TransferTarget) => {
      const dst = await freeTarget(target);
      if (kind === 'move') {
        const entry = await local(src.provider).entryPath(src.virtualPath);
        try {
          await rename(entry, dst);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        }
        try {
          await copyTree(entry, dst, '/', progress(src), false);
        } catch (err) {
          await rm(dst, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
        await rm(entry, { recursive: true });
        return;
      }
      try {
        await copyTree(src.absPath, dst, '/', progress(src));
      } catch (err) {
        await rm(dst, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    };

    for (const [i, src] of plan.sources.entries()) {
      if (ctx.signal.aborted) throw new CancelledError();
      const before = doneBytes;
      ctx.update({ currentItem: src.virtualPath, doneBytes });
      const result = await this.files.transferItem(
        plan.kind,
        src,
        plan.dest,
        plan.conflict,
        exec,
        (err) => err instanceof CancelledError || ctx.signal.aborted,
      );
      // Skipped, failed or renamed-in-place items still count as processed.
      doneBytes = before + sizes[i]!;
      ctx.addResult(result);
      ctx.update({ doneItems: i + 1, doneBytes });
    }
  }
}
