import { readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

export interface SweepOptions {
  maxAgeMs: number;
  maxTotalBytes: number;
  now?: number;
}

export interface SweepResult {
  removed: number;
  remainingBytes: number;
}

/** Marks a cache entry as recently used so the sweeper keeps it (mtime drives eviction). */
export async function touch(file: string): Promise<void> {
  const now = new Date();
  await utimes(file, now, now).catch(() => {});
}

/**
 * Removes cache files older than `maxAgeMs`, then evicts the least recently
 * used ones until the directory fits in `maxTotalBytes`.
 */
export async function sweepCache(dir: string, opts: SweepOptions): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { removed: 0, remainingBytes: 0 };
  }

  const files: { file: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const st = await stat(file).catch(() => null);
    if (st?.isFile()) files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
  }

  let removed = 0;
  const kept: typeof files = [];
  for (const f of files) {
    if (now - f.mtimeMs > opts.maxAgeMs) {
      await rm(f.file, { force: true });
      removed++;
    } else {
      kept.push(f);
    }
  }

  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = kept.reduce((sum, f) => sum + f.size, 0);
  for (const f of kept) {
    if (total <= opts.maxTotalBytes) break;
    await rm(f.file, { force: true });
    total -= f.size;
    removed++;
  }
  return { removed, remainingBytes: total };
}
