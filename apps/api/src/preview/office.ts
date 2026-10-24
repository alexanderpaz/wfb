import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import type { ResolvedRef } from '../files/index.js';
import { extensionOf } from '../storage/entries.js';
import type { EntryInfo } from '../storage/provider.js';
import { touch } from './cache-sweeper.js';
import { Inflight, Semaphore, unsupported } from './limits.js';

export interface OfficeOptions {
  enabled: boolean;
  sofficePath: string;
  cacheDir: string;
  timeoutMs: number;
  maxInputBytes: number;
}

/** Converts Office documents to PDF with LibreOffice headless and caches the result. */
export class OfficeConverter {
  // LibreOffice is memory hungry and not safe to run concurrently with a shared profile.
  private readonly semaphore = new Semaphore(1);
  private readonly inflight = new Inflight<void>();

  constructor(private readonly opts: OfficeOptions) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  cacheKey(ref: ResolvedRef, info: EntryInfo): string {
    return createHash('sha256')
      .update(['pdf-v1', ref.shareId, ref.virtualPath, info.modifiedAt.getTime(), info.size].join('\0'))
      .digest('hex');
  }

  /** Returns the cached PDF file name (relative to `cacheDir`), converting on a miss. */
  async toPdf(ref: ResolvedRef, info: EntryInfo): Promise<string> {
    if (!this.opts.enabled) throw unsupported('Office previews are disabled');
    if (info.size > this.opts.maxInputBytes) throw unsupported('Document too large to preview');
    const key = this.cacheKey(ref, info);
    const name = `${key}.pdf`;
    const target = path.join(this.opts.cacheDir, name);
    if (await exists(target)) {
      await touch(target);
      return name;
    }
    await this.inflight.run(key, async () => {
      if (await exists(target)) return;
      await this.semaphore.run(() => this.convert(ref, info, target));
    });
    return name;
  }

  private async convert(ref: ResolvedRef, info: EntryInfo, target: string): Promise<void> {
    const work = await mkdtemp(path.join(tmpdir(), 'wfb-office-'));
    try {
      const outDir = path.join(work, 'out');
      await mkdir(outDir);
      // A fixed, safe name: never pass user-controlled file names to soffice.
      const input = path.join(work, `input.${extensionOf(info.name).replace(/[^a-z0-9]/g, '') || 'bin'}`);
      await pipeline(
        await ref.provider.createReadStream(ref.virtualPath),
        sizeGuard(this.opts.maxInputBytes),
        createWriteStream(input, { flags: 'wx' }),
      );
      await this.run(work, [
        `-env:UserInstallation=${pathToFileURL(path.join(work, 'lo-profile')).href}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nologo',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        input,
      ]);
      const produced = path.join(outDir, 'input.pdf');
      if (!(await exists(produced))) throw unsupported('LibreOffice did not produce a PDF');
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      await copyFile(produced, temp);
      await rename(temp, target);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private run(work: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.sofficePath, args, {
        cwd: work,
        env: { ...process.env, HOME: work },
        stdio: 'ignore',
        // Own process group so a timeout also kills soffice.bin spawned by the wrapper script.
        detached: true,
      });
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        reject(unsupported('Office conversion timed out'));
      }, this.opts.timeoutMs);
      child.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          err.code === 'ENOENT' || err.code === 'EACCES' ? unsupported('LibreOffice is not available') : err,
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(unsupported(`Office conversion failed (exit code ${code})`));
      });
    });
  }
}

function sizeGuard(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) cb(unsupported('Document too large to preview'));
      else cb(null, chunk);
    },
  });
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}
