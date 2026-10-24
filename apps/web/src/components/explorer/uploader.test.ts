// @vitest-environment node
import type { FileEntry, UploadSession } from '@wfb/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../api/client';
import { chunkedUpload, isRetryable, UploadCancelledError, type UploadApi } from './uploader';

const entry: FileEntry = {
  name: 'f.bin',
  path: '/f.bin',
  type: 'file',
  size: 10,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  mime: null,
  previewable: false,
};

/** In-memory server double with optional failure injection per call. */
function fakeServer(size: number, chunkSize = 4) {
  const state = { offset: 0, received: [] as string[], aborted: false, completed: false };
  const session = (): UploadSession => ({ id: 'u1', size, offset: state.offset, chunkSize });
  const failures: ((call: { offset: number; chunk: Blob }) => unknown)[] = [];
  const client: UploadApi = {
    createUpload: vi.fn(async () => session()),
    uploadStatus: vi.fn(async () => session()),
    uploadChunk: vi.fn(async (_id: string, offset: number, chunk: Blob) => {
      const fail = failures.shift()?.({ offset, chunk });
      if (fail === 'commit-then-fail') {
        state.received.push(await chunk.text());
        state.offset += chunk.size;
        throw new TypeError('Failed to fetch');
      }
      if (fail) throw fail;
      if (offset !== state.offset) {
        throw new ApiRequestError(409, 'CONFLICT', 'Offset mismatch', { offset: state.offset });
      }
      state.received.push(await chunk.text());
      state.offset += chunk.size;
      return session();
    }),
    completeUpload: vi.fn(async () => {
      state.completed = true;
      return { entry };
    }),
    abortUpload: vi.fn(async () => {
      state.aborted = true;
      return { ok: true as const };
    }),
  };
  return { state, client, failures };
}

const file = (text: string) => new Blob([text]);
const dest = { share: 'home', path: '/' };

describe('chunkedUpload', () => {
  it('sends the file in chunks and completes', async () => {
    const { state, client } = fakeServer(10);
    const progress: number[] = [];
    const result = await chunkedUpload({
      file: file('0123456789'),
      name: 'f.bin',
      destination: dest,
      client,
      onProgress: (sent) => progress.push(sent),
    });
    expect(result).toEqual(entry);
    expect(state.received).toEqual(['0123', '4567', '89']);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(client.createUpload).toHaveBeenCalledWith({
      share: 'home',
      path: '/',
      name: 'f.bin',
      size: 10,
      conflict: 'fail',
    });
    expect(state.completed).toBe(true);
  });

  it('resumes from the server offset after a network error', async () => {
    const { state, client, failures } = fakeServer(10);
    // Second chunk reaches the server but the response is lost.
    failures.push(() => null, () => 'commit-then-fail');
    const result = await chunkedUpload({
      file: file('0123456789'),
      name: 'f.bin',
      destination: dest,
      client,
      retryDelayMs: () => 0,
    });
    expect(result).toEqual(entry);
    expect(client.uploadStatus).toHaveBeenCalledTimes(1);
    expect(state.received).toEqual(['0123', '4567', '89']);
  });

  it('re-synchronises on a 409 offset mismatch without counting a retry', async () => {
    const { state, client } = fakeServer(10);
    state.offset = 4;
    state.received.push('0123');
    (client.createUpload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'u1',
      size: 10,
      offset: 0,
      chunkSize: 4,
    });
    await chunkedUpload({ file: file('0123456789'), name: 'f.bin', destination: dest, client, maxRetries: 0 });
    expect(state.received).toEqual(['0123', '4567', '89']);
  });

  it('retries 5xx with backoff and gives up after maxRetries', async () => {
    const { state, client, failures } = fakeServer(10);
    const boom = () => new ApiRequestError(503, 'INTERNAL', 'busy');
    failures.push(boom, boom, boom);
    const delays: number[] = [];
    await expect(
      chunkedUpload({
        file: file('0123456789'),
        name: 'f.bin',
        destination: dest,
        client,
        maxRetries: 2,
        retryDelayMs: (n) => (delays.push(n), 0),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(delays).toEqual([1, 2]);
    expect(state.aborted).toBe(true);
  });

  it('does not retry client errors', async () => {
    const { client, failures } = fakeServer(10);
    failures.push(() => new ApiRequestError(403, 'FORBIDDEN', 'no'));
    await expect(
      chunkedUpload({ file: file('0123456789'), name: 'f.bin', destination: dest, client }),
    ).rejects.toMatchObject({ status: 403 });
    expect(client.uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('cancels and aborts the server session', async () => {
    const { state, client } = fakeServer(10);
    const controller = new AbortController();
    const upload = chunkedUpload({
      file: file('0123456789'),
      name: 'f.bin',
      destination: dest,
      client,
      signal: controller.signal,
      onProgress: (sent) => sent >= 4 && controller.abort(),
    });
    await expect(upload).rejects.toBeInstanceOf(UploadCancelledError);
    expect(state.aborted).toBe(true);
    expect(state.completed).toBe(false);
    expect(state.received).toEqual(['0123']);
  });

  it('classifies retryable errors', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryable(new ApiRequestError(502, 'INTERNAL', 'x'))).toBe(true);
    expect(isRetryable(new ApiRequestError(409, 'CONFLICT', 'x'))).toBe(false);
  });
});
