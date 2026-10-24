import { joinPath, normalizeVirtualPath, pathSegments, type Share } from '@wfb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { toast } from '../../stores/toasts';
import { Menu, type MenuItem } from '../ui/Menu';
import { errorMessage } from './errors';
import { FileIcon, Icon, ShareIcon } from './icons';
import { listKey } from './useFileOps';
import type { Location } from './useNavigation';

interface AddressBarProps {
  shares: Share[];
  location: Location;
  share: Share | undefined;
  canBack: boolean;
  canForward: boolean;
  backLabel?: string;
  forwardLabel?: string;
  search: string;
  onSearch: (q: string) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNavigate: (loc: Location) => void;
  onToggleNav?: () => void;
  navToggleVisible: boolean;
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Parses "/share/a/b" (share by id or name, case-insensitive) into a location. */
export function parseAddress(text: string, shares: Share[]): Location | null {
  const segs = text.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  const first = segs.shift();
  if (!first) return null;
  const lower = first.toLocaleLowerCase('es');
  const share = shares.find((s) => s.id.toLowerCase() === lower || s.name.toLocaleLowerCase('es') === lower);
  if (!share) return null;
  const path = normalizeVirtualPath('/' + segs.join('/'));
  return path === null ? null : { share: share.id, path };
}

export function AddressBar(p: AddressBarProps) {
  const { location, share } = p;
  const [editing, setEditing] = useState(false);
  const [crumbMenu, setCrumbMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const segs = pathSegments(location.path);
  const shareName = share?.name ?? location.share;
  const folderName = segs.length ? segs[segs.length - 1]! : shareName;
  const parentLabel = segs.length ? (segs.length > 1 ? segs[segs.length - 2]! : shareName) : undefined;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const crumbs = [{ label: shareName, path: '/' }];
  let acc = '/';
  for (const s of segs) {
    acc = joinPath(acc, s);
    crumbs.push({ label: s, path: acc });
  }

  const submit = (value: string) => {
    const loc = parseAddress(value, p.shares);
    if (!loc) {
      toast.error('No se encuentra la ubicación', `Compruebe la ruta «${value}» e inténtelo de nuevo.`);
      return;
    }
    setEditing(false);
    p.onNavigate(loc);
  };

  const openCrumbMenu = async (el: HTMLElement, path: string) => {
    const r = el.getBoundingClientRect();
    try {
      const data = await qc.fetchQuery({
        queryKey: listKey(location.share, path),
        queryFn: () => api.list({ share: location.share, path }),
        staleTime: 10_000,
      });
      const folders = data.entries
        .filter((e) => e.type === 'directory')
        .sort((a, b) => collator.compare(a.name, b.name));
      const items: MenuItem[] = folders.length
        ? folders.map((f) => ({
            id: f.path,
            label: f.name,
            icon: <FileIcon kind="folder" size={16} />,
            onSelect: () => p.onNavigate({ share: location.share, path: f.path }),
          }))
        : [{ label: '(Sin subcarpetas)', disabled: true }];
      setCrumbMenu({ x: r.left, y: r.bottom + 2, items });
    } catch (e) {
      toast.error('No se puede abrir la carpeta', errorMessage(e));
    }
  };

  return (
    <div className="wfb-navrow">
      {p.navToggleVisible && (
        <button
          type="button"
          className="wfb-iconbtn"
          title="Panel de navegación"
          aria-label="Panel de navegación"
          onClick={p.onToggleNav}
        >
          <Icon.Menu />
        </button>
      )}
      <button
        type="button"
        className="wfb-iconbtn"
        aria-label="Atrás"
        title={p.backLabel ? `Atrás a ${p.backLabel} (Alt+Flecha izquierda)` : 'Atrás (Alt+Flecha izquierda)'}
        disabled={!p.canBack}
        onClick={p.onBack}
      >
        <Icon.Back />
      </button>
      <button
        type="button"
        className="wfb-iconbtn"
        aria-label="Adelante"
        title={
          p.forwardLabel
            ? `Adelante a ${p.forwardLabel} (Alt+Flecha derecha)`
            : 'Adelante (Alt+Flecha derecha)'
        }
        disabled={!p.canForward}
        onClick={p.onForward}
      >
        <Icon.Forward />
      </button>
      <button
        type="button"
        className="wfb-iconbtn"
        aria-label="Subir un nivel"
        title={
          parentLabel ? `Subir a «${parentLabel}» (Alt+Flecha arriba)` : 'Subir un nivel (Alt+Flecha arriba)'
        }
        disabled={segs.length === 0}
        onClick={p.onUp}
      >
        <Icon.Up />
      </button>
      <button
        type="button"
        className="wfb-iconbtn"
        aria-label="Actualizar"
        title="Actualizar (F5)"
        onClick={p.onRefresh}
      >
        <Icon.Refresh />
      </button>

      <div
        className={`wfb-address${editing ? ' is-editing' : ''}`}
        onClick={() => !editing && setEditing(true)}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="wfb-address-input"
            aria-label="Dirección"
            defaultValue={`/${shareName}${location.path === '/' ? '' : location.path}`}
            spellCheck={false}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') submit(e.currentTarget.value);
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => setEditing(false)}
          />
        ) : (
          <nav aria-label="Ruta de navegación" className="wfb-crumbs">
            <span className="wfb-crumb-icon" aria-hidden="true">
              {segs.length === 0 && share ? (
                <ShareIcon visibility={share.visibility} size={16} />
              ) : (
                <FileIcon kind="folder" size={16} />
              )}
            </span>
            <ol>
              {crumbs.map((c, i) => (
                <li key={c.path}>
                  <button
                    type="button"
                    className="wfb-crumb"
                    aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onNavigate({ share: location.share, path: c.path });
                    }}
                  >
                    {c.label}
                  </button>
                  <button
                    type="button"
                    className="wfb-crumb-sep"
                    aria-label={`Subcarpetas de ${c.label}`}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openCrumbMenu(e.currentTarget, c.path);
                    }}
                  >
                    <Icon.ChevronRight size={12} />
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>

      <label className="wfb-search">
        <input
          type="search"
          placeholder={`Buscar en ${folderName}`}
          aria-label={`Buscar en ${folderName}`}
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') p.onSearch('');
          }}
        />
        <Icon.Search />
      </label>

      {crumbMenu && (
        <Menu
          items={crumbMenu.items}
          x={crumbMenu.x}
          y={crumbMenu.y}
          label="Subcarpetas"
          onClose={() => setCrumbMenu(null)}
        />
      )}
    </div>
  );
}
