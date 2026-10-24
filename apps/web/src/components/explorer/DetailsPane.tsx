import type { FileEntry, Share } from '@wfb/contracts';
import type { ReactNode } from 'react';
import { countLabel, fileKind, formatDate, formatSize, typeLabel } from './fileTypes';
import { FileIcon, ShareIcon } from './icons';

interface DetailsPaneProps {
  share: Share | undefined;
  folderName: string;
  folderPath: string;
  itemCount: number;
  selection: FileEntry[];
  renderPreview?: (entry: FileEntry, share: string) => ReactNode;
  onClose: () => void;
}

const PERMS: Record<string, string> = { read: 'Lectura', write: 'Escritura', delete: 'Eliminación' };
const VISIBILITY: Record<Share['visibility'], string> = {
  public: 'Público',
  private: 'Privado',
  home: 'Carpeta personal',
};

export function DetailsPane(p: DetailsPaneProps) {
  const single = p.selection.length === 1 ? p.selection[0]! : null;
  const shareId = p.share?.id ?? '';
  const totalSize = p.selection.reduce((n, e) => n + (e.type === 'file' ? e.size : 0), 0);

  return (
    <aside className="wfb-details" aria-label="Panel de detalles">
      <button
        type="button"
        className="wfb-details-close"
        aria-label="Cerrar el panel de detalles"
        onClick={p.onClose}
      >
        ×
      </button>
      {single ? (
        <>
          <div className="wfb-details-hero">
            {(single.type === 'file' && p.renderPreview?.(single, shareId)) || (
              <FileIcon kind={fileKind(single)} size={96} />
            )}
          </div>
          <h2 className="wfb-details-title" title={single.name}>
            {single.name}
          </h2>
          <p className="wfb-details-sub">{typeLabel(single)}</p>
          <dl className="wfb-props">
            <dt>Tipo</dt>
            <dd>{typeLabel(single)}</dd>
            {single.type === 'file' && (
              <>
                <dt>Tamaño</dt>
                <dd>
                  {formatSize(single.size)}
                  {single.size >= 1024 && (
                    <span className="wfb-muted">
                      {' '}
                      ({new Intl.NumberFormat('es').format(single.size)} bytes)
                    </span>
                  )}
                </dd>
              </>
            )}
            <dt>Fecha de modificación</dt>
            <dd>{formatDate(single.modifiedAt)}</dd>
            <dt>Ubicación</dt>
            <dd className="wfb-break">
              {p.share?.name}
              {single.path.slice(0, single.path.lastIndexOf('/')) || '/'}
            </dd>
            {single.mime && (
              <>
                <dt>Tipo MIME</dt>
                <dd>{single.mime}</dd>
              </>
            )}
          </dl>
        </>
      ) : p.selection.length > 1 ? (
        <>
          <div className="wfb-details-hero">
            <FileIcon kind="generic" size={96} />
          </div>
          <h2 className="wfb-details-title">
            {countLabel(p.selection.length, 'elemento seleccionado', 'elementos seleccionados')}
          </h2>
          <dl className="wfb-props">
            {totalSize > 0 && (
              <>
                <dt>Tamaño total</dt>
                <dd>{formatSize(totalSize)}</dd>
              </>
            )}
            <dt>Carpetas</dt>
            <dd>{p.selection.filter((e) => e.type === 'directory').length}</dd>
            <dt>Archivos</dt>
            <dd>{p.selection.filter((e) => e.type === 'file').length}</dd>
          </dl>
        </>
      ) : (
        <>
          <div className="wfb-details-hero">
            {p.folderPath === '/' && p.share ? (
              <ShareIcon visibility={p.share.visibility} size={96} />
            ) : (
              <FileIcon kind="folder" size={96} />
            )}
          </div>
          <h2 className="wfb-details-title">{p.folderName}</h2>
          <p className="wfb-details-sub">{countLabel(p.itemCount)}</p>
          {p.share && (
            <dl className="wfb-props">
              <dt>Recurso compartido</dt>
              <dd>{p.share.name}</dd>
              {p.share.description && (
                <>
                  <dt>Descripción</dt>
                  <dd>{p.share.description}</dd>
                </>
              )}
              <dt>Visibilidad</dt>
              <dd>{VISIBILITY[p.share.visibility]}</dd>
              <dt>Permisos</dt>
              <dd>{p.share.permissions.map((x) => PERMS[x] ?? x).join(', ')}</dd>
            </dl>
          )}
          <p className="wfb-details-hint">Seleccione un archivo para ver sus detalles.</p>
        </>
      )}
    </aside>
  );
}
