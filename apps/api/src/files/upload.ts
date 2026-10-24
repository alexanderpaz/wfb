import type { MultipartFile } from '@fastify/multipart';
import { Transform, type Readable } from 'node:stream';
import { HttpError } from '../lib/errors.js';

export const tooLarge = (maxBytes: number) =>
  new HttpError(
    'PAYLOAD_TOO_LARGE',
    `File exceeds the maximum upload size of ${Math.floor(maxBytes)} bytes`,
    {
      maxBytes: Math.floor(maxBytes),
    },
  );

/**
 * Busboy just ends a truncated file stream; this wrapper turns truncation
 * into a stream error so partial files are never committed.
 */
export function guardedFileStream(part: MultipartFile, maxBytes: number): Readable {
  const guard = new Transform({
    transform: (chunk, _enc, cb) => cb(null, chunk),
    flush: (cb) => cb(part.file.truncated ? tooLarge(maxBytes) : null),
  });
  part.file.on('error', (err) => guard.destroy(err));
  // The consumer may attach after the error (e.g. after an async exists() check);
  // the error stays recorded on the stream and is reported by pipeline().
  guard.on('error', () => {});
  return part.file.pipe(guard);
}
