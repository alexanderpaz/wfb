import {
  joinPath,
  type ConflictStrategy,
  type CreateUploadRequest,
  type FileEntry,
  type UploadSession,
  type User,
} from '@wfb/contracts';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import type { FilesService } from '../files/index.js';
import { tooLarge } from '../files/upload.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import type { KeyValueStore } from '../lib/kv.js';
import { LocalStorageProvider } from '../storage/local.js';
import { freeName, sanitizeFileName } from '../storage/names.js';

const TTL_SECONDS = 24 * 60 * 60;
const ID_RE = /^[0-9a-f]{32}$/;

interface UploadState {
  id: string;
  owner: string;
  share: string;
  path: string;
  name: string;
  size: number;
  offset: number;
  conflict: ConflictStrategy;
  part: string;
  createdAt: string;
}

export interface UploadServiceOptions {
  dataDir: string;
  maxUploadBytes: number;
  chunkSize?: number;
}

const key = (id: string) => `upload:${id}`;

/** Resumable chunked uploads: state in the key/value store, data in `<dataDir>/uploads/<id>.part`. */
export class UploadService {
  readonly chunkSize: number;
  readonly dir: string;
  private readonly busy = new Set<string>();

  constructor(
    private readonly files: FilesService,
    private readonly kv: KeyValueStore,
    private readonly opts: UploadServiceOptions,
  ) {
    this.chunkSize = opts.chunkSize ?? 8 * 1024 * 1024;
    this.dir = path.resolve(opts.dataDir, 'uploads');
  }

  private session(s: UploadState): UploadSession {
    return { id: s.id, size: s.size, offset: s.offset, chunkSize: this.chunkSize };
  }

  private async load(user: User, id: string): Promise<UploadState> {
    if (!ID_RE.test(id)) throw notFound('Upload not found');
    const raw = await this.kv.get(key(id));
    const state = raw ? (JSON.parse(raw) as UploadState) : null;
    if (!state || state.owner !== user.id) throw notFound('Upload not found');
    return state;
  }

  private save(state: UploadState) {
    return this.kv.set(key(state.id), JSON.stringify(state), TTL_SECONDS);
  }

  async create(user: User, req: z.output<typeof CreateUploadRequest>): Promise<UploadSession> {
    const dest = await this.files.uploadDestination(user, req);
    const name = sanitizeFileName(req.name);
    if (!name) throw badRequest('Invalid file name', { name: req.name });
    (dest.provider as LocalStorageProvider).assertValidName(name);
    if (req.size > this.opts.maxUploadBytes) throw tooLarge(this.opts.maxUploadBytes);
    if (req.conflict === 'fail' && (await dest.provider.exists(joinPath(dest.virtualPath, name)))) {
      throw conflict('An entry with that name already exists', { conflicts: [{ name }] });
    }

    const id = randomBytes(16).toString('hex');
    await mkdir(this.dir, { recursive: true });
    const part = path.join(this.dir, `${id}.part`);
    await writeFile(part, '', { flag: 'wx' });
    const state: UploadState = {
      id,
      owner: user.id,
      share: dest.shareId,
      path: dest.virtualPath,
      name,
      size: req.size,
      offset: 0,
      conflict: req.conflict,
      part,
      createdAt: new Date().toISOString(),
    };
    await this.save(state);
    return this.session(state);
  }

  async get(user: User, id: string): Promise<UploadSession> {
    return this.session(await this.load(user, id));
  }

  /** Appends `body` at `offset`, which must be the current offset. */
  async append(user: User, id: string, offset: number, body: Readable, length?: number): Promise<UploadSession> {
    const state = await this.load(user, id);
    if (this.busy.has(id)) throw conflict('Another chunk is being written', { offset: state.offset });
    if (offset !== state.offset) throw conflict('Offset mismatch', { offset: state.offset });
    const remaining = state.size - state.offset;
    const max = Math.min(this.chunkSize, remaining);
    if (length !== undefined && length > max) {
      body.resume();
      throw length > remaining ? badRequest('Chunk exceeds the declared size', { offset: state.offset }) : tooLarge(max);
    }

    this.busy.add(id);
    let received = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > max) {
          return cb(
            received > remaining
              ? badRequest('Chunk exceeds the declared size', { offset: state.offset })
              : tooLarge(max),
          );
        }
        cb(null, chunk);
      },
    });
    try {
      // Drops bytes left behind by an interrupted write.
      await truncate(state.part, state.offset);
      await pipeline(body, guard, createWriteStream(state.part, { flags: 'r+', start: state.offset }));
      state.offset += received;
      await this.save(state);
      return this.session(state);
    } catch (err) {
      body.resume();
      await truncate(state.part, state.offset).catch(() => {});
      if (err instanceof HttpError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('Upload not found');
      throw err;
    } finally {
      this.busy.delete(id);
    }
  }

  /** Moves the finished file into the share applying the conflict strategy. */
  async complete(user: User, id: string): Promise<FileEntry> {
    const state = await this.load(user, id);
    if (state.offset !== state.size) {
      throw conflict('Upload is not complete', { offset: state.offset, size: state.size });
    }
    if (this.busy.has(id)) throw conflict('Another chunk is being written', { offset: state.offset });
    const dest = await this.files.uploadDestination(user, { share: state.share, path: state.path });
    const provider = dest.provider as LocalStorageProvider;
    let target = joinPath(dest.virtualPath, state.name);
    let overwrite = false;
    if (await provider.exists(target)) {
      switch (state.conflict) {
        case 'fail':
          throw conflict('An entry with that name already exists', { conflicts: [{ name: state.name }] });
        case 'skip':
          await this.discard(state);
          return this.files.toEntry(dest.share, await provider.stat(target));
        case 'rename':
          target = joinPath(
            dest.virtualPath,
            await freeName(state.name, false, (c) => provider.exists(joinPath(dest.virtualPath, c))),
          );
          break;
        case 'overwrite':
          overwrite = true;
          break;
      }
    }

    this.busy.add(id);
    try {
      const dst = await provider.entryPath(target);
      const temp = path.join(path.dirname(dst), `.wfb-upload-${randomBytes(8).toString('hex')}.tmp`);
      try {
        try {
          await rename(state.part, temp);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await pipeline(createReadStream(state.part), createWriteStream(temp, { flags: 'wx' }));
          await unlink(state.part);
        }
        const existing = await lstat(dst).catch(() => null);
        if (existing && !overwrite) throw conflict('An entry with that name already exists');
        if (existing?.isDirectory()) await rm(dst, { recursive: true });
        await rename(temp, dst);
      } catch (err) {
        // Keep the data so the client can retry the completion.
        await rename(temp, state.part).catch(() => unlink(temp).catch(() => {}));
        throw err;
      }
      await this.kv.del(key(id));
      return this.files.toEntry(dest.share, await provider.stat(target));
    } finally {
      this.busy.delete(id);
    }
  }

  private async discard(state: UploadState) {
    await this.kv.del(key(state.id));
    await rm(state.part, { force: true });
  }

  async abort(user: User, id: string): Promise<void> {
    await this.discard(await this.load(user, id));
  }

  /** Deletes `.part` files without upload state (expired or from a previous process). */
  async cleanupStale(minAgeMs = 60 * 60 * 1000): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    const now = Date.now();
    for (const name of names) {
      const m = /^([0-9a-f]{32})\.part$/.exec(name);
      if (!m) continue;
      const file = path.join(this.dir, name);
      try {
        if (await this.kv.get(key(m[1]!))) continue;
        if (now - (await stat(file)).mtimeMs < minAgeMs) continue;
        await rm(file, { force: true });
        removed++;
      } catch {
        // Ignore races with concurrent completion.
      }
    }
    return removed;
  }
}
