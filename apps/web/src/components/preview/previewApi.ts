import { useQuery } from '@tanstack/react-query';
import type { FileEntry, FileRef, PreviewInfoResponse, ThumbnailSize } from '@wfb/contracts';
import { apiUrl, request } from '../../api/client';

/** Changes whenever the file does, so browser caches (thumbnails are max-age=3600) never go stale. */
const version = (entry: Pick<FileEntry, 'modifiedAt' | 'size'>) =>
  `${Date.parse(entry.modifiedAt) || 0}-${entry.size}`;

export const previewApi = {
  info: (r: FileRef) =>
    request<PreviewInfoResponse>('GET', '/preview/info', { query: { share: r.share, path: r.path } }),
  thumbnailUrl: (r: FileRef, size: ThumbnailSize, v?: string) =>
    apiUrl('/preview/thumbnail', { share: r.share, path: r.path, size, v }),
};

export const previewInfoKey = (share: string, path: string) => ['preview-info', share, path] as const;

export function usePreviewInfo(entry: FileEntry, share: string, enabled = true) {
  return useQuery({
    queryKey: previewInfoKey(share, entry.path),
    queryFn: () => previewApi.info({ share, path: entry.path }),
    enabled: enabled && entry.type === 'file',
    staleTime: 30_000,
  });
}

export function versioned(url: string, entry: Pick<FileEntry, 'modifiedAt' | 'size'>): string {
  return `${url}${url.includes('?') ? '&' : '?'}v=${version(entry)}`;
}

export function thumbnailUrl(share: string, entry: FileEntry, size: ThumbnailSize): string {
  return previewApi.thumbnailUrl({ share, path: entry.path }, size, version(entry));
}

export interface TextContent {
  text: string;
  truncated: boolean;
}

export class PreviewContentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<TextContent> {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) {
    const message =
      res.status === 415
        ? 'El archivo no parece de texto (contiene datos binarios).'
        : res.status === 404
          ? 'El archivo ya no existe.'
          : res.status === 403
            ? 'No tiene permiso para ver este archivo.'
            : 'No se pudo cargar el contenido.';
    throw new PreviewContentError(res.status, message);
  }
  return { text: await res.text(), truncated: res.headers.get('x-preview-truncated') === 'true' };
}
