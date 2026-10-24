import { z } from 'zod';
import { QueryBoolean } from './common.js';
import { VirtualPath } from './paths.js';

export const Permission = z.enum(['read', 'write', 'delete']);
export type Permission = z.infer<typeof Permission>;

export const Share = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.enum(['public', 'private', 'home']),
  permissions: z.array(Permission),
});
export type Share = z.infer<typeof Share>;

export const SharesResponse = z.object({ shares: z.array(Share) });
export type SharesResponse = z.infer<typeof SharesResponse>;

export const FileEntry = z.object({
  name: z.string(),
  /** Path inside the share, POSIX style, always starting with "/". */
  path: VirtualPath,
  type: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  /** ISO 8601 */
  modifiedAt: z.string(),
  mime: z.string().nullable(),
  /** True when the server can render a preview for this entry. */
  previewable: z.boolean(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FileRef = z.object({
  share: z.string().min(1),
  path: VirtualPath,
});
export type FileRef = z.infer<typeof FileRef>;

/** GET /api/files?share=&path= */
export const ListQuery = FileRef;
export type ListQuery = z.infer<typeof ListQuery>;

export const ListResponse = z.object({
  share: z.string(),
  path: VirtualPath,
  entries: z.array(FileEntry),
});
export type ListResponse = z.infer<typeof ListResponse>;

/** GET /api/files/stat?share=&path= */
export const StatResponse = z.object({ entry: FileEntry });
export type StatResponse = z.infer<typeof StatResponse>;

export const ConflictStrategy = z.enum(['fail', 'overwrite', 'skip', 'rename']);
export type ConflictStrategy = z.infer<typeof ConflictStrategy>;

const FileName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => n !== '.' && n !== '..' && !/[/\\\0]/.test(n), 'Invalid file name');

/** POST /api/files/copy and POST /api/files/move */
export const TransferRequest = z.object({
  items: z.array(FileRef).min(1).max(1000),
  destination: FileRef,
  conflict: ConflictStrategy.default('fail'),
});
export type TransferRequest = z.input<typeof TransferRequest>;

export const TransferItemResult = z.object({
  source: FileRef,
  status: z.enum(['done', 'skipped', 'failed']),
  target: FileRef.nullable(),
  error: z.string().nullable(),
});
export type TransferItemResult = z.infer<typeof TransferItemResult>;

/**
 * Small operations complete synchronously (`results`). Large ones return a job
 * that can be followed through GET /api/jobs/:id/events (SSE).
 */
export const TransferResponse = z.union([
  z.object({ mode: z.literal('sync'), results: z.array(TransferItemResult) }),
  z.object({ mode: z.literal('job'), jobId: z.string() }),
]);
export type TransferResponse = z.infer<typeof TransferResponse>;

/** POST /api/files/rename */
export const RenameRequest = FileRef.extend({ newName: FileName });
export type RenameRequest = z.infer<typeof RenameRequest>;

export const EntryResponse = z.object({ entry: FileEntry });
export type EntryResponse = z.infer<typeof EntryResponse>;

/** POST /api/files/mkdir — creates `name` inside `path`. */
export const MkdirRequest = FileRef.extend({ name: FileName });
export type MkdirRequest = z.infer<typeof MkdirRequest>;

/** POST /api/files/delete — moves to trash unless `permanent`. */
export const DeleteRequest = z.object({
  items: z.array(FileRef).min(1).max(1000),
  permanent: z.boolean().default(false),
});
export type DeleteRequest = z.input<typeof DeleteRequest>;

export const DeleteResponse = z.object({
  results: z.array(
    z.object({
      source: FileRef,
      status: z.enum(['deleted', 'trashed', 'failed']),
      error: z.string().nullable(),
    }),
  ),
});
export type DeleteResponse = z.infer<typeof DeleteResponse>;

/**
 * POST /api/files/upload?share=&path=&conflict= (multipart, field "file", may repeat)
 * Simple upload for small files. Large files use the chunked upload API below.
 */
export const UploadQuery = FileRef.extend({ conflict: ConflictStrategy.default('fail') });
export type UploadQuery = z.input<typeof UploadQuery>;

export const UploadResponse = z.object({ entries: z.array(FileEntry) });
export type UploadResponse = z.infer<typeof UploadResponse>;

/** POST /api/uploads — start a resumable chunked upload. */
export const CreateUploadRequest = FileRef.extend({
  name: FileName,
  size: z.number().int().nonnegative(),
  conflict: ConflictStrategy.default('fail'),
});
export type CreateUploadRequest = z.input<typeof CreateUploadRequest>;

export const UploadSession = z.object({
  id: z.string(),
  size: z.number().int().nonnegative(),
  /** Bytes already received; the client resumes from here. */
  offset: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
});
export type UploadSession = z.infer<typeof UploadSession>;
/*
 * GET  /api/uploads/:id                       -> UploadSession
 * PUT  /api/uploads/:id?offset=N  (raw body)  -> UploadSession
 * POST /api/uploads/:id/complete              -> EntryResponse
 * DELETE /api/uploads/:id                     -> OkResponse
 */

/** GET /api/files/download?share=&path=  — supports HTTP Range. */
export const DownloadQuery = FileRef.extend({ inline: QueryBoolean.optional() });
export type DownloadQuery = z.infer<typeof DownloadQuery>;

/** GET /api/search?share=&path=&q= — recursive name search. */
export const SearchQuery = FileRef.extend({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type SearchQuery = z.input<typeof SearchQuery>;

export const SearchResponse = z.object({
  results: z.array(FileEntry),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const TrashItem = z.object({
  id: z.string(),
  share: z.string(),
  originalPath: VirtualPath,
  name: z.string(),
  type: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  deletedAt: z.string(),
  deletedBy: z.string(),
});
export type TrashItem = z.infer<typeof TrashItem>;

/** GET /api/trash?share= */
export const TrashListResponse = z.object({ items: z.array(TrashItem) });
export type TrashListResponse = z.infer<typeof TrashListResponse>;

/** POST /api/trash/restore and POST /api/trash/purge */
export const TrashActionRequest = z.object({
  share: z.string(),
  ids: z.array(z.string()).min(1),
});
export type TrashActionRequest = z.infer<typeof TrashActionRequest>;
