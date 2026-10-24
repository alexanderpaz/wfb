import type { ConflictStrategy, FileEntry, FileRef, UploadSession } from '@wfb/contracts';
import { api, ApiRequestError } from '../../api/client';

/** Files above this size use the resumable chunked upload API. */
export const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;

export interface UploadApi {
  createUpload: typeof api.createUpload;
  uploadStatus: typeof api.uploadStatus;
  uploadChunk: typeof api.uploadChunk;
  completeUpload: typeof api.completeUpload;
  abortUpload: typeof api.abortUpload;
}

export interface ChunkedUploadOptions {
  file: Blob;
  name: string;
  destination: FileRef;
  conflict?: ConflictStrategy;
  signal?: AbortSignal;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /** Consecutive failed attempts tolerated before giving up. */
  maxRetries?: number;
  /** Delay before retry number `attempt` (1-based). */
  retryDelayMs?: (attempt: number) => number;
  client?: UploadApi;
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Subida cancelada');
    this.name = 'UploadCancelledError';
  }
}

/** Network failures and 5xx/429 answers are worth retrying; other API errors are final. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof ApiRequestError) return e.status >= 500 || e.status === 429;
  return e instanceof TypeError || (e instanceof Error && e.name === 'NetworkError');
}

const offsetFromConflict = (e: unknown): number | null => {
  if (!(e instanceof ApiRequestError) || e.status !== 409) return null;
  const offset = (e.details as { offset?: unknown } | undefined)?.offset;
  return typeof offset === 'number' ? offset : null;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadCancelledError());
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new UploadCancelledError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Uploads `file` in chunks. On network errors it waits, asks the server for
 * the stored offset (GET /uploads/:id) and resumes from there; a 409 with
 * `details.offset` re-synchronises immediately. Cancelling aborts the session.
 */
export async function chunkedUpload(opts: ChunkedUploadOptions): Promise<FileEntry> {
  const client = opts.client ?? api;
  const maxRetries = opts.maxRetries ?? 5;
  const delay = opts.retryDelayMs ?? ((n: number) => Math.min(30_000, 500 * 2 ** (n - 1)));
  const { signal } = opts;
  const size = opts.file.size;
  const checkCancelled = () => {
    if (signal?.aborted) throw new UploadCancelledError();
  };

  let failures = 0;
  const retry = async (e: unknown) => {
    if (signal?.aborted) throw new UploadCancelledError();
    if (!isRetryable(e) || ++failures > maxRetries) throw e;
    await sleep(delay(failures), signal);
  };

  let session: UploadSession | null = null;
  while (!session) {
    checkCancelled();
    try {
      session = await client.createUpload({
        share: opts.destination.share,
        path: opts.destination.path,
        name: opts.name,
        size,
        conflict: opts.conflict ?? 'fail',
      });
    } catch (e) {
      await retry(e);
    }
  }
  const id = session.id;
  const chunkSize = session.chunkSize;
  let offset = session.offset;
  opts.onProgress?.(offset, size);

  try {
    let needSync = false;
    while (offset < size || needSync) {
      checkCancelled();
      try {
        if (needSync) {
          offset = (await client.uploadStatus(id)).offset;
          needSync = false;
          opts.onProgress?.(offset, size);
          continue;
        }
        const end = Math.min(size, offset + chunkSize);
        const chunk = opts.file.slice(offset, end);
        const next = (await client.uploadChunk(id, offset, chunk, signal)).offset;
        if (next !== end) throw new Error('El servidor no ha recibido el fragmento completo.');
        offset = next;
        failures = 0;
        opts.onProgress?.(offset, size);
      } catch (e) {
        const serverOffset = offsetFromConflict(e);
        if (serverOffset !== null && !signal?.aborted) {
          offset = serverOffset;
          opts.onProgress?.(offset, size);
          continue;
        }
        await retry(e);
        needSync = true;
      }
    }

    for (;;) {
      checkCancelled();
      try {
        return (await client.completeUpload(id)).entry;
      } catch (e) {
        await retry(e);
      }
    }
  } catch (e) {
    // The session cannot be resumed by a later call: free the server-side data.
    await client.abortUpload(id).catch(() => {});
    if (e instanceof UploadCancelledError || signal?.aborted) throw new UploadCancelledError();
    throw e;
  }
}
