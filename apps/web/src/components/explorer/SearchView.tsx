import type { FileEntry, SearchResponse } from '@wfb/contracts';
import { useEffect, useState } from 'react';
import { errorMessage } from './errors';
import { fileKind, formatDate, formatSize } from './fileTypes';
import { FileIcon, Icon } from './icons';
import { folderLabel } from './TrashView';
import './ops.css';

interface SearchViewProps {
  /** Name of the folder searched ("Resultados de búsqueda en X"). */
  scopeName: string;
  shareName: string;
  query: string;
  data: SearchResponse | undefined;
  loading: boolean;
  error: unknown;
  onOpen: (entry: FileEntry) => void;
  onRetry: () => void;
}

/** Recursive search results with the folder of each match. */
export function SearchView(p: SearchViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const results = p.data?.results ?? [];
  useEffect(() => setSelected(null), [p.query]);

  const index = results.findIndex((r) => r.path === selected);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(results.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
      setSelected(results[index < 0 ? 0 : next]!.path);
    } else if (e.key === 'Enter' && index >= 0) {
      e.preventDefault();
      p.onOpen(results[index]!);
    }
  };

  return (
    <div className="wfb-ops-view">
      <div className="wfb-ops-header">
        <h2 className="wfb-ops-title">
          <Icon.Search size={18} /> Resultados de búsqueda en {p.scopeName}
        </h2>
        {p.loading && <span className="wfb-spinner is-small" role="status" aria-label="Buscando" />}
      </div>
      {p.data?.truncated && (
        <div className="wfb-ops-notice" role="note">
          Se muestran solo los primeros {results.length} resultados. Escriba un término más concreto para
          acotar la búsqueda.
        </div>
      )}
      <div className="wfb-ops-table is-search">
        <div className="wfb-ops-row wfb-ops-head" role="presentation">
          <span>Nombre</span>
          <span>Carpeta</span>
          <span>Fecha de modificación</span>
          <span className="is-right">Tamaño</span>
        </div>
        <div
          className="wfb-ops-items"
          role="listbox"
          aria-label={`Resultados de búsqueda en ${p.scopeName}`}
          aria-busy={p.loading || undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {p.error && !p.data ? (
            <div className="wfb-pane-message" role="alert">
              <strong>No se pudo completar la búsqueda</strong>
              <span>{errorMessage(p.error)}</span>
              <button type="button" className="wfb-btn" onClick={p.onRetry}>
                Reintentar
              </button>
            </div>
          ) : !p.data ? (
            <div className="wfb-empty" role="status">
              Buscando «{p.query}»…
            </div>
          ) : results.length === 0 ? (
            <div className="wfb-empty">No se han encontrado elementos que coincidan con «{p.query}».</div>
          ) : (
            results.map((entry) => (
              <div
                key={entry.path}
                role="option"
                aria-selected={selected === entry.path}
                aria-label={entry.name}
                data-path={entry.path}
                className={`wfb-ops-row wfb-item${selected === entry.path ? ' is-selected' : ''}`}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => p.onOpen(entry)}
              >
                <span className="wfb-cell wfb-cell-name">
                  <FileIcon kind={fileKind(entry)} size={18} />
                  <span className="wfb-item-name" title={entry.name}>
                    {entry.name}
                  </span>
                </span>
                <span className="wfb-cell wfb-cell-muted" title={entry.path}>
                  {folderLabel(p.shareName, entry.path)}
                </span>
                <span className="wfb-cell wfb-cell-muted">{formatDate(entry.modifiedAt)}</span>
                <span className="wfb-cell wfb-cell-muted is-right">
                  {entry.type === 'directory' ? '' : formatSize(entry.size)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
