import { joinPath, type FileEntry, type SearchQuery, type User } from '@wfb/contracts';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import type { FilesService } from '../files/index.js';
import { badRequest } from '../lib/errors.js';
import { LocalStorageProvider } from '../storage/local.js';

export interface SearchLimits {
  maxDepth: number;
  maxVisited: number;
  timeBudgetMs: number;
}

const DEFAULT_LIMITS: SearchLimits = { maxDepth: 20, maxVisited: 50_000, timeBudgetMs: 3000 };

/** Case- and accent-insensitive form used for matching ("Ingeniería" -> "ingenieria"). */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const isInside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** Recursive, bounded name search below a folder of a share. */
export class SearchService {
  constructor(
    private readonly files: FilesService,
    private readonly limits: SearchLimits = DEFAULT_LIMITS,
  ) {}

  async search(
    user: User,
    query: z.output<typeof SearchQuery>,
  ): Promise<{ results: FileEntry[]; truncated: boolean }> {
    const ref = await this.files.resolveRef(user, query, 'read');
    if (!(ref.provider instanceof LocalStorageProvider)) throw new Error('Only local storage is supported');
    const provider = ref.provider;
    if (!(await stat(ref.absPath)).isDirectory()) throw badRequest('Search path is not a folder');

    const root = await realpath(ref.share.path);
    const needle = foldName(query.q);
    const deadline = Date.now() + this.limits.timeBudgetMs;
    const results: FileEntry[] = [];
    let visited = 0;
    let truncated = false;

    // Breadth-first so shallower matches come first when the walk is cut short.
    let level: { abs: string; virtual: string }[] = [{ abs: ref.absPath, virtual: ref.virtualPath }];
    for (let depth = 1; level.length > 0 && !truncated; depth++) {
      if (depth > this.limits.maxDepth) {
        truncated = true;
        break;
      }
      const next: typeof level = [];
      for (const dir of level) {
        if (Date.now() > deadline || visited >= this.limits.maxVisited) {
          truncated = true;
          break;
        }
        let dirents;
        try {
          dirents = await readdir(dir.abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of dirents) {
          if (provider.isHiddenName(d.name)) continue;
          if (++visited > this.limits.maxVisited) {
            truncated = true;
            break;
          }
          const abs = path.join(dir.abs, d.name);
          const virtual = joinPath(dir.virtual, d.name);
          const matches = foldName(d.name).includes(needle);
          if (d.isSymbolicLink()) {
            // Links are reported when they stay inside the share, never traversed.
            try {
              if (!isInside(root, await realpath(abs))) continue;
            } catch {
              continue;
            }
          } else if (d.isDirectory()) {
            next.push({ abs, virtual });
          } else if (!d.isFile()) {
            continue;
          }
          if (matches) {
            if (results.length >= query.limit) {
              truncated = true;
              break;
            }
            try {
              const st = await stat(abs);
              results.push(
                this.files.toEntry(ref.share, {
                  name: d.name,
                  path: virtual,
                  type: st.isDirectory() ? 'directory' : 'file',
                  size: st.isDirectory() ? 0 : st.size,
                  modifiedAt: st.mtime,
                }),
              );
            } catch {
              // Removed while searching.
            }
          }
        }
        if (truncated) break;
      }
      level = next;
    }
    return { results, truncated };
  }
}
