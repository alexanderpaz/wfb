import { useQuery } from '@tanstack/react-query';
import { highlight } from './highlight';
import { fetchText } from './previewApi';
import { PreviewMessage } from './PreviewMessage';

interface TextPreviewProps {
  url: string;
  language: string | null | undefined;
  compact?: boolean;
}

export function TextPreview({ url, language, compact }: TextPreviewProps) {
  const content = useQuery({
    queryKey: ['preview-text', url],
    queryFn: ({ signal }) => fetchText(url, signal),
    staleTime: 30_000,
    retry: false,
  });
  const text = content.data?.text;
  const html = useQuery({
    queryKey: ['preview-highlight', url, language],
    queryFn: () => highlight(text ?? '', language),
    enabled: text !== undefined,
    staleTime: Infinity,
    retry: false,
  });

  if (content.isPending) return <PreviewMessage loading>Cargando vista previa…</PreviewMessage>;
  if (content.isError) {
    return (
      <PreviewMessage error>{content.error.message || 'No se pudo cargar la vista previa.'}</PreviewMessage>
    );
  }
  const { truncated } = content.data;
  return (
    <div className={`wfb-pv-text${compact ? ' is-compact' : ''}`}>
      {truncated && <p className="wfb-pv-note">Vista previa truncada (1 MB)</p>}
      {text === '' ? (
        <PreviewMessage>El archivo está vacío.</PreviewMessage>
      ) : (
        <pre className="wfb-pv-code" tabIndex={0} aria-label="Contenido del archivo">
          {html.data ? (
            <code
              className="hljs"
              data-language={language ?? undefined}
              dangerouslySetInnerHTML={{ __html: html.data }}
            />
          ) : (
            <code>{text}</code>
          )}
        </pre>
      )}
    </div>
  );
}
