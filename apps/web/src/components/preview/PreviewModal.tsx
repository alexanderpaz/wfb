import type { FileEntry } from '@wfb/contracts';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { fileKind } from '../explorer/fileTypes';
import { FileIcon } from '../explorer/icons';
import { PreviewBody } from './PreviewBody';
import { usePreviewInfo, versioned } from './previewApi';
import './preview.css';

export interface PreviewModalProps {
  entry: FileEntry;
  share: string;
  /** Previewable files of the same folder in display order; enables ←/→ navigation. */
  siblings?: FileEntry[];
  onNavigate?: (entry: FileEntry) => void;
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], audio, video, iframe, [tabindex="0"]';

/** Full-screen viewer. Esc closes, ←/→ move between `siblings`. */
export function PreviewModal({ entry, share, siblings = [], onNavigate, onClose }: PreviewModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(document.activeElement);
  const info = usePreviewInfo(entry, share);

  const index = siblings.findIndex((s) => s.path === entry.path);
  const prev = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;
  const fileRef = { share, path: entry.path };
  const newTabUrl = info.data?.contentUrl
    ? versioned(info.data.contentUrl, entry)
    : api.downloadUrl(fileRef, true);

  useEffect(() => {
    ref.current?.focus();
    const prevFocus = restore.current;
    return () => {
      if (prevFocus instanceof HTMLElement && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/^(AUDIO|VIDEO)$/.test(target.tagName)) {
      const to = e.key === 'ArrowLeft' ? prev : next;
      if (to && onNavigate) {
        e.preventDefault();
        onNavigate(to);
      }
    } else if (e.key === 'Tab' && ref.current) {
      const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="wfb-pv-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Vista previa: ${entry.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="wfb-pv-toolbar">
        <FileIcon kind={fileKind(entry)} size={20} />
        <h2 className="wfb-pv-title" title={entry.name}>
          {entry.name}
        </h2>
        {siblings.length > 1 && index >= 0 && (
          <span className="wfb-pv-counter">
            {index + 1} de {siblings.length}
          </span>
        )}
        <span className="wfb-pv-spacer" />
        {siblings.length > 1 && (
          <>
            <button
              type="button"
              className="wfb-pv-btn"
              disabled={!prev}
              onClick={() => prev && onNavigate?.(prev)}
              aria-label="Anterior"
              title="Anterior (←)"
            >
              ‹
            </button>
            <button
              type="button"
              className="wfb-pv-btn"
              disabled={!next}
              onClick={() => next && onNavigate?.(next)}
              aria-label="Siguiente"
              title="Siguiente (→)"
            >
              ›
            </button>
          </>
        )}
        <a className="wfb-pv-btn is-text" href={api.downloadUrl(fileRef)} download={entry.name}>
          Descargar
        </a>
        <a className="wfb-pv-btn is-text" href={newTabUrl} target="_blank" rel="noopener noreferrer">
          Abrir en pestaña nueva
        </a>
        <button
          type="button"
          className="wfb-pv-btn"
          onClick={onClose}
          aria-label="Cerrar"
          title="Cerrar (Esc)"
        >
          ×
        </button>
      </header>
      <div className="wfb-pv-stage">
        <PreviewBody key={`${share}:${entry.path}`} entry={entry} share={share} variant="modal" />
      </div>
    </div>,
    document.body,
  );
}
