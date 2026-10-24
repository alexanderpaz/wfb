import { THUMBNAIL_PIXELS, type ThumbnailSize } from '@wfb/contracts';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { ResolvedRef } from '../files/index.js';
import type { EntryInfo } from '../storage/provider.js';
import { touch } from './cache-sweeper.js';
import { Inflight, readLimited, Semaphore, unsupported, writeAtomic } from './limits.js';

export interface ThumbnailOptions {
  cacheDir: string;
  maxInputBytes: number;
  /** Rejects images whose decoded size exceeds this many pixels (decompression bombs). */
  maxInputPixels: number;
  concurrency: number;
}

export interface Thumbnail {
  file: string;
  etag: string;
  /** False when the cached file already existed. */
  generated: boolean;
}

const CACHE_VERSION = 'v1';

export class ThumbnailService {
  private readonly semaphore: Semaphore;
  private readonly inflight = new Inflight<boolean>();

  constructor(private readonly opts: ThumbnailOptions) {
    this.semaphore = new Semaphore(opts.concurrency);
  }

  cacheKey(ref: ResolvedRef, info: EntryInfo, size: ThumbnailSize): string {
    return createHash('sha256')
      .update(
        [CACHE_VERSION, ref.shareId, ref.virtualPath, info.modifiedAt.getTime(), info.size, size].join('\0'),
      )
      .digest('hex');
  }

  async get(ref: ResolvedRef, info: EntryInfo, size: ThumbnailSize): Promise<Thumbnail> {
    if (info.type !== 'file') throw unsupported('Folders have no thumbnail');
    if (info.size > this.opts.maxInputBytes) throw unsupported('File too large for a thumbnail');
    const key = this.cacheKey(ref, info, size);
    const file = path.join(this.opts.cacheDir, `${key}.webp`);
    const etag = `"${key.slice(0, 32)}"`;
    if (await isFile(file)) {
      await touch(file);
      return { file, etag, generated: false };
    }

    const generated = await this.inflight.run(key, async () => {
      if (await isFile(file)) return false;
      const input = await readLimited(
        await ref.provider.createReadStream(ref.virtualPath),
        this.opts.maxInputBytes,
      );
      const output = await this.semaphore.run(() => this.render(input, THUMBNAIL_PIXELS[size]));
      await writeAtomic(file, output);
      return true;
    });
    return { file, etag, generated };
  }

  private async render(input: Buffer, px: number): Promise<Buffer> {
    try {
      return await sharp(input, { limitInputPixels: this.opts.maxInputPixels, pages: 1 })
        .rotate()
        .resize(px, px, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    } catch (err) {
      throw unsupported(`Cannot create a thumbnail: ${(err as Error).message}`);
    }
  }
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}
