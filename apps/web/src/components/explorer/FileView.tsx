import type { FileEntry } from '@wfb/contracts';
import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type Ref } from 'react';
import type { SortDir, SortKey, ViewMode } from '../../stores/explorerPrefs';
import { fileKind, formatDate, formatSize, stem, typeLabel } from './fileTypes';
import { FileIcon, Icon } from './icons';

export type DropProps = Pick<
  HTMLAttributes<HTMLElement>,
  'onDragOver' | 'onDragEnter' | 'onDragLeave' | 'onDrop'
>;

export type DragProps = DropProps & {
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLElement>) => void;
};

const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'name', label: 'Nombre' },
  { key: 'modifiedAt', label: 'Fecha de modificación' },
  { key: 'type', label: 'Tipo' },
  { key: 'size', label: 'Tamaño', align: 'right' },
];

export interface FileViewProps {
  label: string;
  entries: FileEntry[];
  view: ViewMode;
  selected: ReadonlySet<string>;
  focused: string | null;
  renaming: string | null;
  cutPaths: ReadonlySet<string>;
  /** Path of the folder highlighted as drop target, or "" when the background is. */
  dropTarget: string | null;
  sortKey: SortKey;
  sortDir: SortDir;
  columns: Record<SortKey, number>;
  listRef: Ref<HTMLDivElement>;
  idPrefix: string;
  empty: React.ReactNode;
  onSort: (key: SortKey) => void;
  onResizeColumn: (key: SortKey, width: number) => void;
  onItemClick: (entry: FileEntry, e: React.MouseEvent) => void;
  onItemOpen: (entry: FileEntry) => void;
  onItemContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
  onBackgroundContextMenu: (e: React.MouseEvent) => void;
  onBackgroundClick: () => void;
  onRubberBand: (paths: string[]) => void;
  onRenameCommit: (entry: FileEntry, name: string) => void;
  onRenameCancel: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  itemDragProps: (entry: FileEntry) => DragProps;
  backgroundDropProps: DropProps;
  renderBigIcon?: (entry: FileEntry, fallback: React.ReactNode) => React.ReactNode;
}

export function FileView(p: FileViewProps) {
  const { view, entries } = p;
  const paneRef = useRef<HTMLDivElement>(null);
  const band = useRubberBand(paneRef, p.selected, p.onRubberBand);

  const gridTemplate = `${p.columns.name}px ${p.columns.modifiedAt}px ${p.columns.type}px ${p.columns.size}px`;
  const activeId = p.focused !== null ? entries.findIndex((e) => e.path === p.focused) : -1;

  return (
    <div
      ref={paneRef}
      className={`wfb-pane wfb-view-${view}${p.dropTarget === '' ? ' is-drop-target' : ''}`}
      style={{ '--wfb-cols': gridTemplate } as React.CSSProperties}
      onMouseDown={band.onMouseDown}
      onClick={(e) => {
        if (band.consumeClick()) return;
        if (!(e.target as Element).closest('[role="option"]')) p.onBackgroundClick();
      }}
      onContextMenu={(e) => {
        if ((e.target as Element).closest('[role="option"], input')) return;
        e.preventDefault();
        p.onBackgroundContextMenu(e);
      }}
      {...p.backgroundDropProps}
    >
      {view === 'details' && (
        <div className="wfb-header" role="presentation">
          {COLUMNS.map((c) => (
            <div key={c.key} className="wfb-header-cell" role="presentation">
              <button
                type="button"
                className={`wfb-header-btn${c.align === 'right' ? ' is-right' : ''}${p.sortKey === c.key ? ' is-sorted' : ''}`}
                aria-sort={
                  p.sortKey === c.key ? (p.sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                }
                tabIndex={-1}
                onClick={() => p.onSort(c.key)}
              >
                {c.label}
                {p.sortKey === c.key && (
                  <span className={`wfb-sort-arrow is-${p.sortDir}`} aria-hidden="true">
                    <Icon.ChevronDown size={10} />
                  </span>
                )}
              </button>
              <ColumnResizer width={p.columns[c.key]} onResize={(w) => p.onResizeColumn(c.key, w)} />
            </div>
          ))}
        </div>
      )}
      <div
        ref={p.listRef}
        className="wfb-items"
        role="listbox"
        aria-label={p.label}
        aria-multiselectable="true"
        aria-orientation={view === 'details' ? 'vertical' : undefined}
        aria-activedescendant={activeId >= 0 ? `${p.idPrefix}-${activeId}` : undefined}
        tabIndex={0}
        onKeyDown={p.onKeyDown}
      >
        {entries.length === 0 && p.empty}
        {entries.map((entry, index) => {
          const selected = p.selected.has(entry.path);
          const kind = fileKind(entry);
          const isFolder = entry.type === 'directory';
          const classes = [
            'wfb-item',
            selected && 'is-selected',
            p.focused === entry.path && 'is-focused',
            p.cutPaths.has(entry.path) && 'is-cut',
            p.dropTarget === entry.path && 'is-drop-target',
          ]
            .filter(Boolean)
            .join(' ');
          const name =
            p.renaming === entry.path ? (
              <RenameInput
                entry={entry}
                onCommit={(n) => p.onRenameCommit(entry, n)}
                onCancel={p.onRenameCancel}
              />
            ) : (
              <span className="wfb-item-name" title={entry.name}>
                {entry.name}
              </span>
            );
          return (
            <div
              key={entry.path}
              id={`${p.idPrefix}-${index}`}
              role="option"
              aria-selected={selected}
              aria-label={entry.name}
              data-path={entry.path}
              className={classes}
              title={view === 'details' ? undefined : tooltip(entry)}
              onClick={(e) => p.onItemClick(entry, e)}
              onDoubleClick={() => p.onItemOpen(entry)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                p.onItemContextMenu(entry, e);
              }}
              {...p.itemDragProps(entry)}
            >
              {view === 'details' ? (
                <>
                  <span className="wfb-cell wfb-cell-name">
                    <FileIcon kind={kind} size={18} />
                    {name}
                  </span>
                  <span className="wfb-cell wfb-cell-muted">{formatDate(entry.modifiedAt)}</span>
                  <span className="wfb-cell wfb-cell-muted">{typeLabel(entry)}</span>
                  <span className="wfb-cell wfb-cell-muted is-right">
                    {isFolder ? '' : formatSize(entry.size)}
                  </span>
                </>
              ) : view === 'icons' ? (
                <>
                  {p.renderBigIcon && entry.previewable && kind === 'image' ? (
                    <span className="wfb-item-bigicon wfb-item-thumb">
                      {p.renderBigIcon(entry, <FileIcon kind={kind} size={64} />)}
                    </span>
                  ) : (
                    <FileIcon kind={kind} size={64} className="wfb-item-bigicon" />
                  )}
                  {name}
                </>
              ) : (
                <>
                  <FileIcon kind={kind} size={16} />
                  {name}
                </>
              )}
            </div>
          );
        })}
      </div>
      {band.rect && (
        <div
          className="wfb-rubberband"
          style={{ left: band.rect.x, top: band.rect.y, width: band.rect.w, height: band.rect.h }}
        />
      )}
    </div>
  );
}

function tooltip(e: FileEntry) {
  const lines = [`Tipo: ${typeLabel(e)}`];
  if (e.type === 'file') lines.push(`Tamaño: ${formatSize(e.size)}`);
  lines.push(`Fecha de modificación: ${formatDate(e.modifiedAt)}`);
  return `${e.name}\n${lines.join('\n')}`;
}

function RenameInput({
  entry,
  onCommit,
  onCancel,
}: {
  entry: FileEntry;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = entry.type === 'directory' ? entry.name.length : stem(entry.name).length;
    el.setSelectionRange(0, end);
  }, [entry]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value.trim() ?? '';
    if (commit && value && value !== entry.name) onCommit(value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="wfb-rename"
      aria-label="Nuevo nombre"
      defaultValue={entry.name}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function ColumnResizer({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  return (
    <span
      className="wfb-col-resizer"
      aria-hidden="true"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const el = e.currentTarget;
        el.setPointerCapture?.(e.pointerId);
        const move = (ev: PointerEvent) => onResize(width + ev.clientX - startX);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangle selection by dragging on the empty area of the pane. */
function useRubberBand(
  paneRef: React.RefObject<HTMLDivElement>,
  selected: ReadonlySet<string>,
  onSelect: (paths: string[]) => void,
) {
  const [rect, setRect] = useState<Rect | null>(null);
  const moved = useRef(false);

  const onMouseDown = (e: React.MouseEvent) => {
    const target = e.target as Element;
    if (e.button !== 0 || target.closest('[role="option"], .wfb-header, input, button')) return;
    const pane = paneRef.current;
    if (!pane) return;
    const origin = pane.getBoundingClientRect();
    const sx = e.clientX - origin.left + pane.scrollLeft;
    const sy = e.clientY - origin.top + pane.scrollTop;
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? [...selected] : [];
    moved.current = false;

    const onMove = (ev: MouseEvent) => {
      const o = pane.getBoundingClientRect();
      const cx = ev.clientX - o.left + pane.scrollLeft;
      const cy = ev.clientY - o.top + pane.scrollTop;
      if (!moved.current && Math.abs(cx - sx) < 4 && Math.abs(cy - sy) < 4) return;
      moved.current = true;
      const r = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) };
      setRect(r);
      const hits = new Set(base);
      pane.querySelectorAll<HTMLElement>('[role="option"]').forEach((el) => {
        const b = el.getBoundingClientRect();
        const bx = b.left - o.left + pane.scrollLeft;
        const by = b.top - o.top + pane.scrollTop;
        if (bx < r.x + r.w && bx + b.width > r.x && by < r.y + r.h && by + b.height > r.y) {
          hits.add(el.dataset.path!);
        }
      });
      onSelect([...hits]);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setRect(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const consumeClick = () => {
    const m = moved.current;
    moved.current = false;
    return m;
  };

  return { rect, onMouseDown, consumeClick };
}
