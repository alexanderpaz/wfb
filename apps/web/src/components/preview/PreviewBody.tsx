import type { FileEntry } from '@wfb/contracts';
import { useState } from 'react';
import { fileKind } from '../explorer/fileTypes';
import { FileIcon } from '../explorer/icons';
import { thumbnailUrl, usePreviewInfo, versioned } from './previewApi';
import { PreviewMessage } from './PreviewMessage';
import { TextPreview } from './TextPreview';
import { ImageWithFallback } from './Thumbnail';

export type PreviewVariant = 'pane' | 'modal';

interface PreviewBodyProps {
  entry: FileEntry;
  share: string;
  variant: PreviewVariant;
}

/** Renders the preview of a file according to `/api/preview/info`. */
export function PreviewBody({ entry, share, variant }: PreviewBodyProps) {
  const info = usePreviewInfo(entry, share);
  const icon = <FileIcon kind={fileKind(entry)} size={variant === 'pane' ? 96 : 128} />;

  if (info.isPending) return <PreviewMessage loading>Cargando vista previa…</PreviewMessage>;
  if (info.isError) {
    return (
      <PreviewMessage error icon={icon}>
        No se pudo cargar la vista previa.
      </PreviewMessage>
    );
  }

  const { kind, contentUrl, language } = info.data;
  const url = contentUrl ? versioned(contentUrl, entry) : null;
  if (!url || kind === 'none') return <NoPreview icon={icon} />;

  switch (kind) {
    case 'image': {
      const thumb = thumbnailUrl(share, entry, variant === 'pane' ? 'medium' : 'large');
      return (
        <ImageWithFallback
          className="wfb-pv-image"
          sources={variant === 'pane' ? [thumb, url] : [url, thumb]}
          alt={entry.name}
          fallback={<NoPreview icon={icon} />}
        />
      );
    }
    case 'pdf':
    case 'office':
      return (
        <iframe
          className="wfb-pv-frame"
          title={`Vista previa de ${entry.name}`}
          src={variant === 'pane' ? `${url}#toolbar=0&view=FitH` : url}
        />
      );
    case 'text':
      return <TextPreview url={url} language={language} compact={variant === 'pane'} />;
    case 'audio':
    case 'video':
      return <MediaPreview kind={kind} url={url} name={entry.name} icon={icon} />;
    default:
      return <NoPreview icon={icon} />;
  }
}

function NoPreview({ icon }: { icon: React.ReactNode }) {
  return <PreviewMessage icon={icon}>No hay vista previa disponible</PreviewMessage>;
}

function MediaPreview({
  kind,
  url,
  name,
  icon,
}: {
  kind: 'audio' | 'video';
  url: string;
  name: string;
  icon: React.ReactNode;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) {
    return (
      <PreviewMessage error icon={icon}>
        El navegador no puede reproducir este archivo.
      </PreviewMessage>
    );
  }
  const onError = () => setFailedUrl(url);
  return kind === 'audio' ? (
    <div className="wfb-pv-audio">
      {icon}
      <audio controls preload="metadata" src={url} aria-label={name} onError={onError} />
    </div>
  ) : (
    <video
      className="wfb-pv-video"
      controls
      preload="metadata"
      src={url}
      aria-label={name}
      onError={onError}
    />
  );
}
