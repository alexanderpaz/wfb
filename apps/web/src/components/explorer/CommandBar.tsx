import { useState, type ReactNode } from 'react';
import { Menu, type MenuItem } from '../ui/Menu';
import { Icon } from './icons';

export interface CommandButton {
  id: string;
  label: string;
  title?: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

interface CommandBarProps {
  newItems: MenuItem[];
  newDisabled: boolean;
  buttons: CommandButton[];
  sortItems: MenuItem[];
  viewItems: MenuItem[];
  showDetails: boolean;
  onToggleDetails: () => void;
  headerRight?: ReactNode;
}

type Open = { id: string; x: number; y: number; label: string } | null;

export function CommandBar(p: CommandBarProps) {
  const [open, setOpen] = useState<Open>(null);

  const dropdown = (
    id: string,
    label: string,
    icon: ReactNode,
    opts: { primary?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      type="button"
      data-wfb-menu-trigger=""
      className={`wfb-cmd${opts.primary ? ' is-primary' : ''}${open?.id === id ? ' is-open' : ''}`}
      aria-haspopup="menu"
      aria-expanded={open?.id === id}
      disabled={opts.disabled}
      onClick={(e) => {
        if (open?.id === id) return setOpen(null);
        const r = e.currentTarget.getBoundingClientRect();
        setOpen({ id, x: r.left, y: r.bottom + 4, label });
      }}
    >
      {icon}
      <span className="wfb-cmd-label">{label}</span>
      <Icon.ChevronDown size={10} />
    </button>
  );

  return (
    <div className="wfb-commandbar" role="toolbar" aria-label="Barra de comandos">
      {dropdown('new', 'Nuevo', <Icon.Plus />, { primary: true, disabled: p.newDisabled })}
      <span className="wfb-cmd-sep" />
      {p.buttons.map((b) => (
        <button
          key={b.id}
          type="button"
          className="wfb-cmd is-icon-only-narrow"
          aria-label={b.label}
          title={b.title ?? b.label}
          disabled={b.disabled}
          onClick={b.onClick}
        >
          {b.icon}
          <span className="wfb-cmd-label">{b.label}</span>
        </button>
      ))}
      <span className="wfb-cmd-sep" />
      {dropdown('sort', 'Ordenar', <Icon.Sort />)}
      {dropdown('view', 'Ver', <Icon.View />)}
      <span className="wfb-cmd-spacer" />
      <button
        type="button"
        className={`wfb-cmd${p.showDetails ? ' is-pressed' : ''}`}
        aria-pressed={p.showDetails}
        title="Panel de detalles (Alt+Mayús+P)"
        onClick={p.onToggleDetails}
      >
        <Icon.Pane />
        <span className="wfb-cmd-label">Panel de detalles</span>
      </button>
      {p.headerRight && <div className="wfb-header-right">{p.headerRight}</div>}
      {open && (
        <Menu
          items={open.id === 'new' ? p.newItems : open.id === 'sort' ? p.sortItems : p.viewItems}
          x={open.x}
          y={open.y}
          label={open.label}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
