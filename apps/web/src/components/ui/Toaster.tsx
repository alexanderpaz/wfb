import { useToasts, type ToastKind } from '../../stores/toasts';
import './ui.css';

const ICON: Record<ToastKind, string> = { info: 'i', success: '✓', error: '!', busy: '' };

/** Renders the global toast stack (bottom-right). */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="wfb-toaster" aria-live="polite" aria-relevant="additions text">
      {toasts.map((t) => (
        <div key={t.id} className={`wfb-toast is-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="wfb-toast-icon" aria-hidden="true">
            {t.kind === 'busy' ? <span className="wfb-spinner" /> : ICON[t.kind]}
          </span>
          <div className="wfb-toast-text">
            <strong>{t.title}</strong>
            {t.message && <span>{t.message}</span>}
          </div>
          {t.kind !== 'busy' && (
            <button
              type="button"
              className="wfb-toast-close"
              aria-label="Descartar"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
