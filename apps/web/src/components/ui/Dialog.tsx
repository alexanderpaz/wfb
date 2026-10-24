import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

export interface DialogProps {
  title: string;
  children?: ReactNode;
  /** Footer content (buttons). */
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex="0"]';

/** Modal dialog with focus trap; Esc closes. Focuses `[data-autofocus]` or the first control. */
export function Dialog({ title, children, footer, onClose, width = 440 }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const restore = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    const el = ref.current;
    const target =
      el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    const prev = restore.current;
    return () => {
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab' && ref.current) {
      const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
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
      className="wfb-dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="wfb-dialog"
        style={{ width }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="wfb-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="wfb-dialog-close" aria-label="Cerrar" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3 3 10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
        <div className="wfb-dialog-body">{children}</div>
        {footer && <div className="wfb-dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
