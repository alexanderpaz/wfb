import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepCache, touch } from '../../src/preview/cache-sweeper.js';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 23);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wfb-sweep-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(name: string, bytes: number, ageMs: number): Promise<void> {
  const file = path.join(dir, name);
  await writeFile(file, Buffer.alloc(bytes));
  const t = new Date(NOW - ageMs);
  await utimes(file, t, t);
}

describe('sweepCache', () => {
  it('removes entries older than maxAgeMs', async () => {
    await put('old.webp', 10, 40 * DAY);
    await put('fresh.webp', 10, 1 * DAY);
    const r = await sweepCache(dir, { maxAgeMs: 30 * DAY, maxTotalBytes: 1e9, now: NOW });
    expect(r).toEqual({ removed: 1, remainingBytes: 10 });
    expect(await readdir(dir)).toEqual(['fresh.webp']);
  });

  it('evicts least recently used entries until under the size cap', async () => {
    await put('a.webp', 100, 3 * DAY);
    await put('b.webp', 100, 2 * DAY);
    await put('c.webp', 100, 1 * DAY);
    const r = await sweepCache(dir, { maxAgeMs: 30 * DAY, maxTotalBytes: 150, now: NOW });
    expect(r).toEqual({ removed: 2, remainingBytes: 100 });
    expect(await readdir(dir)).toEqual(['c.webp']);
  });

  it('ignores a missing directory', async () => {
    const r = await sweepCache(path.join(dir, 'nope'), { maxAgeMs: DAY, maxTotalBytes: 0 });
    expect(r).toEqual({ removed: 0, remainingBytes: 0 });
  });
});

describe('touch', () => {
  it('refreshes mtime so a hit survives age-based eviction', async () => {
    await put('hit.webp', 10, 40 * DAY);
    await touch(path.join(dir, 'hit.webp'));
    expect((await stat(path.join(dir, 'hit.webp'))).mtimeMs).toBeGreaterThan(NOW);
  });
});
