import type { FileEntry } from '@wfb/contracts';
import type { ViewMode } from '../../stores/explorerPrefs';
import { countLabel, formatSize } from './fileTypes';
import { Icon } from './icons';

interface StatusBarProps {
  total: number;
  selection: FileEntry[];
  readOnly: boolean;
  view: ViewMode;
  onView: (v: ViewMode) => void;
}

export function StatusBar({ total, selection, readOnly, view, onView }: StatusBarProps) {
  const files = selection.filter((e) => e.type === 'file');
  const size = files.reduce((n, e) => n + e.size, 0);
  return (
    <footer className="wfb-statusbar" aria-live="polite">
      <span>{countLabel(total)}</span>
      {selection.length > 0 && (
        <>
          <span className="wfb-status-sep" aria-hidden="true">
            |
          </span>
          <span>
            {countLabel(selection.length, 'elemento seleccionado', 'elementos seleccionados')}
            {files.length > 0 && <span className="wfb-status-size">{formatSize(size)}</span>}
          </span>
        </>
      )}
      {readOnly && (
        <>
          <span className="wfb-status-sep" aria-hidden="true">
            |
          </span>
          <span className="wfb-muted">Solo lectura</span>
        </>
      )}
      <span className="wfb-cmd-spacer" />
      <button
        type="button"
        className={`wfb-status-view${view === 'details' ? ' is-pressed' : ''}`}
        aria-label="Detalles"
        title="Muestra información sobre cada elemento"
        aria-pressed={view === 'details'}
        onClick={() => onView('details')}
      >
        <Icon.Details size={14} />
      </button>
      <button
        type="button"
        className={`wfb-status-view${view === 'icons' ? ' is-pressed' : ''}`}
        aria-label="Iconos grandes"
        title="Muestra elementos con iconos grandes"
        aria-pressed={view === 'icons'}
        onClick={() => onView('icons')}
      >
        <Icon.LargeIcons size={14} />
      </button>
    </footer>
  );
}
