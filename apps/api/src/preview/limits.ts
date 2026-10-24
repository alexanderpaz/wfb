import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** Unsupported preview: 415 with the generic BAD_REQUEST ApiError code (see the error handler). */
export function unsupported(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 415 });
}

/** Minimal FIFO semaphore to bound CPU-heavy work (sharp, soffice). */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Coalesces concurrent calls with the same key into one promise. */
export class Inflight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = task().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

/** Reads a stream fully, failing once it exceeds `maxBytes`. */
export async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) throw unsupported('File too large to preview');
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/** Writes `data` to `file` through a temp file + rename so readers never see partial output. */
export async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
