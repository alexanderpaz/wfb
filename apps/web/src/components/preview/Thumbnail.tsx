import type { ThumbnailSize } from '@wfb/contracts';
import { useState, type ReactNode } from 'react';
import { previewApi } from './previewApi';

export interface ThumbnailProps {
  share: string;
  path: string;
  size?: ThumbnailSize;
  /** Rendered while there is no thumbnail (unsupported type, error). */
  fallback?: ReactNode;
  /** Cache-buster, e.g. `entry.modifiedAt`; thumbnails are cached by the browser for an hour. */
  version?: string;
  alt?: string;
  className?: string;
}

/** Lazy `<img>` of `/api/preview/thumbnail`, swapping to `fallback` when it fails to load. */
export function Thumbnail({
  share,
  path,
  size = 'medium',
  fallback = null,
  version,
  alt = '',
  className,
}: ThumbnailProps) {
  const src = previewApi.thumbnailUrl({ share, path }, size, version);
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return <>{fallback}</>;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}

/** Tries each source in order and renders `fallback` once all of them failed. */
export function ImageWithFallback({
  sources,
  alt,
  fallback,
  className,
}: {
  sources: string[];
  alt: string;
  fallback: ReactNode;
  className?: string;
}) {
  const key = sources.join('\n');
  const [index, setIndex] = useState({ key, i: 0 });
  const i = index.key === key ? index.i : 0;
  const src = sources[i];
  if (!src) return <>{fallback}</>;
  return (
    <img
      key={src}
      className={className}
      src={src}
      alt={alt}
      decoding="async"
      draggable={false}
      onError={() => setIndex({ key, i: i + 1 })}
    />
  );
}
