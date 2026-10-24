import { z } from 'zod';
import { FileRef } from './files.js';

export const PreviewKind = z.enum(['image', 'pdf', 'text', 'audio', 'video', 'office', 'none']);
export type PreviewKind = z.infer<typeof PreviewKind>;

export const ThumbnailSize = z.enum(['small', 'medium', 'large']);
export type ThumbnailSize = z.infer<typeof ThumbnailSize>;

export const THUMBNAIL_PIXELS: Record<ThumbnailSize, number> = { small: 64, medium: 256, large: 1024 };

/** GET /api/preview/info?share=&path= */
export const PreviewInfoQuery = FileRef;
export const PreviewInfoResponse = z.object({
  kind: PreviewKind,
  mime: z.string().nullable(),
  /** URL to fetch renderable content (image/pdf/media stream, or text). */
  contentUrl: z.string().nullable(),
  /** For text previews: true when content was truncated to `maxBytes`. */
  truncated: z.boolean().optional(),
  language: z.string().nullable().optional(),
});
export type PreviewInfoResponse = z.infer<typeof PreviewInfoResponse>;

/** GET /api/preview/thumbnail?share=&path=&size= — returns image/webp. */
export const ThumbnailQuery = FileRef.extend({ size: ThumbnailSize.default('medium') });
export type ThumbnailQuery = z.input<typeof ThumbnailQuery>;

/** GET /api/preview/content?share=&path= — text (truncated), PDF (Office converted) or raw stream. */
export const PreviewContentQuery = FileRef;
