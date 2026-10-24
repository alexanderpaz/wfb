import {
  basename,
  dirname,
  joinPath,
  pathSegments,
  type FileEntry,
  type FileRef,
  type Share,
} from '@wfb/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../../api/client';
import { useClipboard } from '../../stores/clipboard';
import { useExplorerPrefs, type SortKey, type ViewMode } from '../../stores/explorerPrefs';
import { toast } from '../../stores/toasts';
import { Dialog } from '../ui/Dialog';
import { Menu, type MenuItem } from '../ui/Menu';
import { Toaster } from '../ui/Toaster';
import { AddressBar } from './AddressBar';
import { CommandBar, type CommandButton } from './CommandBar';
import { DetailsPane } from './DetailsPane';
import { DRAG_MIME, dragPayload, dropLabel, resolveDrop } from './dnd';
import { errorMessage } from './errors';
import { FileView, type DragProps, type DropProps } from './FileView';
import { Icon } from './icons';
import { NavTree, nodeKey, TRASH_ROOT_KEY } from './NavTree';
import { SearchView } from './SearchView';
import { filterEntries, sortEntries } from './sort';
import { StatusBar } from './StatusBar';
import { TransferPanel } from './TransferPanel';
import { trashQueryKey, TrashView } from './TrashView';
import { listKey, useFileOps } from './useFileOps';
import { useNavigation, type Location } from './useNavigation';
import './explorer.css';

export interface ExplorerProps {
  /** Preview shown in the details pane for the selected file (provided by the preview feature). */
  renderPreview?: (entry: FileEntry, share: string) => ReactNode;
  /** Called when a file is opened (double click / Enter / "Abrir"). Defaults to opening it inline in a new tab. */
  onOpenFile?: (entry: FileEntry, share: string) => void;
  /** Rendered at the right end of the command bar (e.g. the user menu). */
  headerRight?: ReactNode;
}

interface Selection {
  selected: Set<string>;
  anchor: string | null;
  focus: string | null;
}

const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null, focus: null };

interface ContextMenuState {
  x: number;
  y: number;
  kind: 'item' | 'background';
  /** Folder used as paste target for "Pegar" on a folder item. */
  target?: FileEntry;
}

interface DropState {
  zone: 'pane' | 'tree';
  key: string;
  x: number;
  y: number;
  label: string;
}

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Nombre',
  modifiedAt: 'Fecha de modificación',
  type: 'Tipo',
  size: 'Tamaño',
};

const VIEW_LABELS: Record<ViewMode, string> = { details: 'Detalles', icons: 'Iconos grandes', list: 'Lista' };

/** Server-side recursive search starts after this pause in typing (or on Enter). */
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_MIN_CHARS = 2;

function defaultOpenFile(entry: FileEntry, share: string) {
  window.open(api.downloadUrl({ share, path: entry.path }, true), '_blank', 'noopener');
}

function triggerDownload(ref: FileRef) {
  const a = document.createElement('a');
  a.href = api.downloadUrl(ref);
  a.download = basename(ref.path);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Items per row (icons) or per column (list) in the current layout, for arrow-key navigation. */
function layoutRun(list: HTMLElement | null, axis: 'row' | 'column'): number {
  const opts = list ? [...list.querySelectorAll<HTMLElement>('[role="option"]')] : [];
  if (opts.length < 2 || opts[0]!.getBoundingClientRect().width === 0) return 1;
  const pos = (el: HTMLElement) => (axis === 'row' ? el.offsetTop : el.offsetLeft);
  const first = pos(opts[0]!);
  let n = 0;
  while (n < opts.length && pos(opts[n]!) === first) n++;
  return Math.max(1, n);
}

function useNarrow(ref: React.RefObject<HTMLElement>, breakpoint: number) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? breakpoint) < breakpoint));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, breakpoint]);
  return narrow;
}

export function Explorer({ renderPreview, onOpenFile = defaultOpenFile, headerRight }: ExplorerProps) {
  const nav = useNavigation();
  const { location } = nav;
  const prefs = useExplorerPrefs();
  const clipboard = useClipboard();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId().replace(/:/g, '');
  const narrow = useNarrow(rootRef, 760);
  const [navOverlay, setNavOverlay] = useState(false);

  const sharesQ = useQuery({ queryKey: ['shares'], queryFn: api.shares });
  const shares = useMemo(() => sharesQ.data?.shares ?? [], [sharesQ.data]);
  const share = shares.find((s) => s.id === location.share);
  const shareById = useCallback((id: string) => shares.find((s) => s.id === id), [shares]);
  const can = useCallback(
    (id: string, perm: Share['permissions'][number]) => !!shareById(id)?.permissions.includes(perm),
    [shareById],
  );
  const inTrash = location.view === 'trash';
  const canWrite = can(location.share, 'write') && !inTrash;
  const canDelete = can(location.share, 'delete') && !inTrash;
  const trashShares = useMemo(
    () => shares.filter((s) => s.permissions.includes('read') && s.permissions.includes('delete')),
    [shares],
  );

  const { replace: replaceLocation, navigate } = nav;
  useEffect(() => {
    if (shares.length > 0 && !share) replaceLocation({ share: shares[0]!.id, path: '/' });
  }, [shares, share, replaceLocation]);

  const listQ = useQuery({
    queryKey: listKey(location.share, location.path),
    queryFn: () => api.list(location),
    enabled: !!share && !inTrash,
  });
  const trashQ = useQuery({
    queryKey: trashQueryKey(location.share),
    queryFn: () => api.trash(location.share),
    enabled: !!share && inTrash,
  });

  useEffect(() => {
    if (listQ.error) toast.error('No se puede abrir la carpeta', errorMessage(listQ.error));
  }, [listQ.error]);
  useEffect(() => {
    if (sharesQ.error)
      toast.error('No se pudieron cargar los recursos compartidos', errorMessage(sharesQ.error));
  }, [sharesQ.error]);

  const describe = useCallback(
    (ref: FileRef) => {
      const s = shareById(ref.share)?.name ?? ref.share;
      return ref.path === '/' ? s : basename(ref.path);
    },
    [shareById],
  );
  const ops = useFileOps(describe);

  // ---- view state ---------------------------------------------------------
  const [search, setSearch] = useState('');
  const [serverQuery, setServerQuery] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ items: FileEntry[]; permanent: boolean } | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const pendingSelect = useRef<string[] | null>(null);

  useEffect(() => {
    const q = search.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setServerQuery(null);
      return;
    }
    const timer = setTimeout(() => setServerQuery(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const searching = serverQuery !== null && !inTrash;
  const searchQ = useQuery({
    queryKey: ['search', location.share, location.path, serverQuery],
    queryFn: ({ signal }) =>
      api.search({ share: location.share, path: location.path, q: serverQuery! }, signal),
    enabled: !!share && searching,
    staleTime: 15_000,
  });

  const allEntries = useMemo(
    () => (inTrash || searching ? [] : (listQ.data?.entries ?? [])),
    [listQ.data, inTrash, searching],
  );
  const entries = useMemo(
    () => sortEntries(filterEntries(allEntries, search), prefs.sortKey, prefs.sortDir),
    [allEntries, search, prefs.sortKey, prefs.sortDir],
  );
  const selection = useMemo(() => entries.filter((e) => sel.selected.has(e.path)), [entries, sel.selected]);
  const selectionRefs = useMemo(
    () => selection.map((e) => ({ share: location.share, path: e.path })),
    [selection, location.share],
  );
  const cutPaths = useMemo(
    () =>
      new Set(
        clipboard.mode === 'cut'
          ? clipboard.items.filter((i) => i.share === location.share).map((i) => i.path)
          : [],
      ),
    [clipboard, location.share],
  );

  const locKey = `${nodeKey(location.share, location.path)}${inTrash ? '#trash' : ''}`;
  useEffect(() => {
    setSearch('');
    setServerQuery(null);
    setRenaming(null);
    setMenu(null);
    setSel(EMPTY_SELECTION);
    setNavOverlay(false);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (inTrash) next.add(TRASH_ROOT_KEY);
      let acc = '/';
      next.add(nodeKey(location.share, acc));
      for (const seg of pathSegments(location.path).slice(0, -1)) {
        acc = joinPath(acc, seg);
        next.add(nodeKey(location.share, acc));
      }
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locKey]);

  // Select items created by paste / mkdir / rename once the refreshed listing contains them.
  useEffect(() => {
    const want = pendingSelect.current;
    if (!want) return;
    const present = want.filter((p) => allEntries.some((e) => e.path === p));
    if (present.length === 0) return;
    pendingSelect.current = null;
    setSel({ selected: new Set(present), anchor: present[0]!, focus: present[0]! });
    listRef.current
      ?.querySelector(`[data-path="${CSS.escape(present[0]!)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [allEntries]);

  const focusList = () => listRef.current?.focus({ preventScroll: true });

  // ---- actions ------------------------------------------------------------
  const current: FileRef = location;

  const goUp = () => {
    if (inTrash) return nav.navigate({ share: location.share, path: '/' });
    if (location.path === '/') return;
    pendingSelect.current = [location.path];
    nav.navigate({ share: location.share, path: dirname(location.path) });
  };

  const open = (entry: FileEntry) => {
    if (entry.type === 'directory') navigate({ share: location.share, path: entry.path });
    else onOpenFile(entry, location.share);
  };

  const submitSearch = (value: string) => {
    const q = value.trim();
    setServerQuery(q.length > 0 ? q : null);
  };

  const openSelection = () => {
    const folder = selection.find((e) => e.type === 'directory');
    if (selection.length === 1 || (folder && selection.every((e) => e.type === 'directory'))) {
      open(folder ?? selection[0]!);
    } else {
      selection.filter((e) => e.type === 'file').forEach(open);
    }
  };

  const copySelection = () => selectionRefs.length && clipboard.set('copy', selectionRefs);
  const cutSelection = () => canDelete && selectionRefs.length && clipboard.set('cut', selectionRefs);

  const pasteInto = async (path: string) => {
    if (!can(location.share, 'write') || clipboard.items.length === 0) return;
    const result = await ops.paste({ share: location.share, path });
    if (result && path === location.path) pendingSelect.current = result.targets.map((r) => r.path);
  };

  const startRename = () => {
    if (!canWrite || selection.length !== 1) return;
    setRenaming(selection[0]!.path);
  };

  const commitRename = async (entry: FileEntry, name: string) => {
    setRenaming(null);
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      toast.error('Nombre no válido', 'El nombre de archivo no puede contener los caracteres / ni \\.');
      return;
    }
    const updated = await ops.rename({ share: location.share, path: entry.path }, name);
    if (updated) pendingSelect.current = [updated.path];
    focusList();
  };

  const askDelete = (permanent: boolean) => {
    if (!canDelete || selection.length === 0) return;
    setConfirmDelete({ items: selection, permanent });
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const { items, permanent } = confirmDelete;
    setConfirmDelete(null);
    const ok = await ops.remove(
      items.map((e) => ({ share: location.share, path: e.path })),
      permanent,
    );
    if (ok) setSel(EMPTY_SELECTION);
  };

  const newFolder = async () => {
    if (!canWrite) return;
    setSearch('');
    const entry = await ops.mkdir(
      current,
      allEntries.map((e) => e.name),
    );
    if (!entry) return;
    setSel({ selected: new Set([entry.path]), anchor: entry.path, focus: entry.path });
    setRenaming(entry.path);
  };

  const pickUpload = () => canWrite && uploadRef.current?.click();

  const download = () => {
    const files = selection.filter((e) => e.type === 'file');
    if (files.length < selection.length)
      toast.info('Las carpetas no se pueden descargar', 'Solo se descargarán los archivos.');
    files.forEach((f) => triggerDownload({ share: location.share, path: f.path }));
  };

  const refresh = () => void ops.refresh(current);

  const selectAll = () =>
    setSel((s) => ({
      selected: new Set(entries.map((e) => e.path)),
      anchor: s.anchor ?? entries[0]?.path ?? null,
      focus: s.focus ?? entries[0]?.path ?? null,
    }));

  const showProperties = () => prefs.setShowDetails(true);

  // ---- selection ----------------------------------------------------------
  const indexOf = (path: string | null) => (path === null ? -1 : entries.findIndex((e) => e.path === path));

  const rangeBetween = (a: string | null, b: string) => {
    const i = Math.max(0, indexOf(a));
    const j = indexOf(b);
    const [lo, hi] = i < j ? [i, j] : [j, i];
    return entries.slice(lo, hi + 1).map((e) => e.path);
  };

  const onItemClick = (entry: FileEntry, e: React.MouseEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    focusList();
    if (e.shiftKey) {
      setSel((s) => {
        const range = rangeBetween(s.anchor ?? entry.path, entry.path);
        const selected = ctrl ? new Set([...s.selected, ...range]) : new Set(range);
        return { selected, anchor: s.anchor ?? entry.path, focus: entry.path };
      });
    } else if (ctrl) {
      setSel((s) => {
        const selected = new Set(s.selected);
        if (selected.has(entry.path)) selected.delete(entry.path);
        else selected.add(entry.path);
        return { selected, anchor: entry.path, focus: entry.path };
      });
    } else {
      setSel({ selected: new Set([entry.path]), anchor: entry.path, focus: entry.path });
    }
  };

  const moveFocus = (target: number, e: React.KeyboardEvent) => {
    if (entries.length === 0) return;
    const i = Math.max(0, Math.min(entries.length - 1, target));
    const path = entries[i]!.path;
    if (e.shiftKey) {
      setSel((s) => ({
        selected: new Set(rangeBetween(s.anchor, path)),
        anchor: s.anchor ?? path,
        focus: path,
      }));
    } else if (e.ctrlKey || e.metaKey) {
      setSel((s) => ({ ...s, focus: path }));
    } else {
      setSel({ selected: new Set([path]), anchor: path, focus: path });
    }
    listRef.current
      ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  };

  const typeahead = useRef({ text: '', at: 0 });

  const openMenuAtFocus = () => {
    const el = sel.focus ? listRef.current?.querySelector(`[data-path="${CSS.escape(sel.focus)}"]`) : null;
    const r = (el ?? listRef.current)?.getBoundingClientRect();
    const x = r ? r.left + Math.min(40, r.width / 2) : 0;
    const y = r ? r.top + Math.min(r.height, 24) : 0;
    setMenu({
      x,
      y,
      kind: selection.length > 0 ? 'item' : 'background',
      target: selection.length === 1 ? selection[0] : undefined,
    });
  };

  // ---- keyboard -----------------------------------------------------------
  const onRootKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.altKey && key === 'ArrowLeft') return (handled(), nav.back());
    if (e.altKey && key === 'ArrowRight') return (handled(), nav.forward());
    if (e.altKey && key === 'ArrowUp') return (handled(), goUp());
    if (e.altKey && e.shiftKey && key.toLowerCase() === 'p')
      return (handled(), prefs.setShowDetails(!prefs.showDetails));
    if (key === 'F5') return (handled(), refresh());
    if (ctrl && e.shiftKey && key.toLowerCase() === 'n') return (handled(), void newFolder());
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const idx = indexOf(sel.focus);
    const view = prefs.view;
    const perRow = view === 'icons' ? layoutRun(listRef.current, 'row') : 1;
    const perCol = view === 'list' ? layoutRun(listRef.current, 'column') : 1;

    if (e.altKey) {
      if (key === 'Enter') return (handled(), showProperties());
      return;
    }
    if (ctrl && !e.shiftKey) {
      switch (key.toLowerCase()) {
        case 'a':
          return (handled(), selectAll());
        case 'c':
          return (handled(), void copySelection());
        case 'x':
          return (handled(), void cutSelection());
        case 'v':
          return (handled(), void pasteInto(location.path));
      }
    }
    switch (key) {
      case 'ArrowDown':
        return (handled(), moveFocus(idx < 0 ? 0 : idx + (view === 'icons' ? perRow : 1), e));
      case 'ArrowUp':
        return (handled(), moveFocus(idx < 0 ? 0 : idx - (view === 'icons' ? perRow : 1), e));
      case 'ArrowRight':
        if (view === 'details') return;
        return (handled(), moveFocus(idx < 0 ? 0 : idx + (view === 'list' ? perCol : 1), e));
      case 'ArrowLeft':
        if (view === 'details') return;
        return (handled(), moveFocus(idx < 0 ? 0 : idx - (view === 'list' ? perCol : 1), e));
      case 'Home':
        return (handled(), moveFocus(0, e));
      case 'End':
        return (handled(), moveFocus(entries.length - 1, e));
      case 'PageDown':
        return (handled(), moveFocus(idx + 10, e));
      case 'PageUp':
        return (handled(), moveFocus(idx - 10, e));
      case ' ':
        if (ctrl && sel.focus) {
          handled();
          const f = sel.focus;
          return setSel((s) => {
            const selected = new Set(s.selected);
            if (selected.has(f)) selected.delete(f);
            else selected.add(f);
            return { ...s, selected, anchor: f };
          });
        }
        return;
      case 'Enter':
        return (handled(), openSelection());
      case 'F2':
        return (handled(), startRename());
      case 'Delete':
        return (handled(), askDelete(e.shiftKey));
      case 'Backspace':
        return (handled(), nav.back());
      case 'Escape':
        if (sel.selected.size > 0) handled();
        return setSel((s) => ({ ...s, selected: new Set() }));
      case 'ContextMenu':
        return (handled(), openMenuAtFocus());
      case 'F10':
        if (e.shiftKey) return (handled(), openMenuAtFocus());
        return;
    }
    if (key.length === 1 && !ctrl && key !== ' ') {
      const now = Date.now();
      const ta = typeahead.current;
      ta.text = now - ta.at > 800 ? key : ta.text + key;
      ta.at = now;
      const q = ta.text.toLocaleLowerCase('es');
      const start = ta.text.length === 1 ? idx + 1 : Math.max(0, idx);
      const ordered = [...entries.slice(start), ...entries.slice(0, start)];
      const hit = ordered.find((x) => x.name.toLocaleLowerCase('es').startsWith(q));
      if (hit) {
        handled();
        moveFocus(indexOf(hit.path), { ...e, shiftKey: false, ctrlKey: false, metaKey: false });
      }
    }
  };

  // ---- drag & drop ----------------------------------------------------------
  const canDeleteShare = useCallback((id: string) => can(id, 'delete'), [can]);

  const dropProps = (ref: FileRef, name: string, zone: DropState['zone'], key: string): DropProps => {
    const target = { ref, name, canWrite: can(ref.share, 'write') };
    return {
      onDragOver: (e) => {
        e.stopPropagation();
        const op = resolveDrop(e, target, canDeleteShare);
        if (!op) {
          e.dataTransfer.dropEffect = 'none';
          if (drop) setDrop(null);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = op === 'move' ? 'move' : 'copy';
        const label = dropLabel(op, name);
        if (
          !drop ||
          drop.key !== key ||
          drop.zone !== zone ||
          drop.label !== label ||
          Math.abs(drop.x - e.clientX) + Math.abs(drop.y - e.clientY) > 3
        ) {
          setDrop({ zone, key, label, x: e.clientX, y: e.clientY });
        }
      },
      onDragLeave: (e) => {
        e.stopPropagation();
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) {
          setDrop((d) => (d && d.key === key && d.zone === zone ? null : d));
        }
      },
      onDrop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrop(null);
        const op = resolveDrop(e, target, canDeleteShare);
        const items = dragPayload.get();
        dragPayload.set(null);
        if (op === 'upload') {
          const files = [...e.dataTransfer.files];
          if (files.length) void ops.upload(ref, files);
        } else if (op && items) {
          void ops.transfer(op, items, ref).then((res) => {
            const cut = useClipboard.getState();
            if (res && op === 'move' && cut.mode === 'cut') {
              const key = (r: FileRef) => `${r.share}:${r.path}`;
              const failed = new Set(res.failed.map(key));
              const moved = new Set(items.map(key).filter((k) => !failed.has(k)));
              const rest = cut.items.filter((i) => !moved.has(key(i)));
              if (rest.length !== cut.items.length) cut.set('cut', rest);
            }
          });
        }
      },
    };
  };

  const itemDragProps = (entry: FileEntry): DragProps => ({
    draggable: renaming !== entry.path,
    onDragStart: (e) => {
      let items = selectionRefs;
      if (!sel.selected.has(entry.path)) {
        items = [{ share: location.share, path: entry.path }];
        setSel({ selected: new Set([entry.path]), anchor: entry.path, focus: entry.path });
      }
      dragPayload.set(items);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(items));
      e.dataTransfer.setData('text/plain', items.map((i) => basename(i.path)).join('\n'));
    },
    onDragEnd: () => {
      dragPayload.set(null);
      setDrop(null);
    },
    ...(entry.type === 'directory'
      ? dropProps({ share: location.share, path: entry.path }, entry.name, 'pane', entry.path)
      : {}),
  });

  // Dropping OS files outside a target must not navigate the browser away.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.defaultPrevented && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
      }
    };
    const dropped = (e: DragEvent) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
      setDrop(null);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', dropped);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', dropped);
    };
  }, []);

  // ---- menus ----------------------------------------------------------------
  const hasClipboard = clipboard.items.length > 0;
  const viewItems: MenuItem[] = (Object.keys(VIEW_LABELS) as ViewMode[]).map((v) => ({
    id: v,
    label: VIEW_LABELS[v],
    checked: prefs.view === v,
    onSelect: () => prefs.setView(v),
  }));
  const sortItems: MenuItem[] = [
    ...(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
      id: k,
      label: SORT_LABELS[k],
      checked: prefs.sortKey === k,
      onSelect: () => prefs.setSort(k, prefs.sortDir),
    })),
    { type: 'separator' as const },
    {
      id: 'asc',
      label: 'Ascendente',
      checked: prefs.sortDir === 'asc',
      onSelect: () => prefs.setSort(prefs.sortKey, 'asc'),
    },
    {
      id: 'desc',
      label: 'Descendente',
      checked: prefs.sortDir === 'desc',
      onSelect: () => prefs.setSort(prefs.sortKey, 'desc'),
    },
  ];
  const newItems: MenuItem[] = [
    {
      label: 'Carpeta',
      icon: <Icon.NewFolder />,
      shortcut: 'Ctrl+Mayús+N',
      disabled: !canWrite,
      onSelect: () => void newFolder(),
    },
    { type: 'separator' },
    { label: 'Subir archivos', icon: <Icon.Upload />, disabled: !canWrite, onSelect: pickUpload },
  ];

  const menuItems = (m: ContextMenuState): MenuItem[] => {
    if (m.kind === 'background') {
      return [
        { label: 'Ver', icon: <Icon.View />, submenu: viewItems },
        { label: 'Ordenar por', icon: <Icon.Sort />, submenu: sortItems },
        { label: 'Actualizar', icon: <Icon.Refresh />, shortcut: 'F5', onSelect: refresh },
        { type: 'separator' },
        {
          label: 'Pegar',
          icon: <Icon.Paste />,
          shortcut: 'Ctrl+V',
          disabled: !canWrite || !hasClipboard,
          onSelect: () => void pasteInto(location.path),
        },
        { type: 'separator' },
        { label: 'Nuevo', icon: <Icon.Plus />, disabled: !canWrite, submenu: newItems.slice(0, 1) },
        { label: 'Subir archivos', icon: <Icon.Upload />, disabled: !canWrite, onSelect: pickUpload },
        { type: 'separator' },
        {
          label: 'Propiedades',
          icon: <Icon.Info />,
          onSelect: () => (setSel(EMPTY_SELECTION), showProperties()),
        },
      ];
    }
    const folder = m.target?.type === 'directory' ? m.target : undefined;
    const hasFiles = selection.some((e) => e.type === 'file');
    return [
      { label: 'Abrir', icon: <Icon.Open />, shortcut: 'Entrar', onSelect: openSelection },
      { type: 'separator' },
      {
        label: 'Cortar',
        icon: <Icon.Cut />,
        shortcut: 'Ctrl+X',
        disabled: !canDelete,
        onSelect: () => void cutSelection(),
      },
      { label: 'Copiar', icon: <Icon.Copy />, shortcut: 'Ctrl+C', onSelect: () => void copySelection() },
      ...(folder
        ? [
            {
              label: 'Pegar',
              icon: <Icon.Paste />,
              disabled: !canWrite || !hasClipboard,
              onSelect: () => void pasteInto(folder.path),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Renombrar',
        icon: <Icon.Rename />,
        shortcut: 'F2',
        disabled: !canWrite || selection.length !== 1,
        onSelect: startRename,
      },
      {
        label: 'Eliminar',
        icon: <Icon.Delete />,
        shortcut: 'Supr',
        disabled: !canDelete,
        onSelect: () => askDelete(false),
      },
      { label: 'Descargar', icon: <Icon.Download />, disabled: !hasFiles, onSelect: download },
      { type: 'separator' },
      { label: 'Propiedades', icon: <Icon.Info />, shortcut: 'Alt+Entrar', onSelect: showProperties },
    ];
  };

  const none = selection.length === 0;
  const buttons: CommandButton[] = [
    {
      id: 'cut',
      label: 'Cortar',
      title: 'Cortar (Ctrl+X)',
      icon: <Icon.Cut />,
      disabled: none || !canDelete,
      onClick: () => void cutSelection(),
    },
    {
      id: 'copy',
      label: 'Copiar',
      title: 'Copiar (Ctrl+C)',
      icon: <Icon.Copy />,
      disabled: none,
      onClick: () => void copySelection(),
    },
    {
      id: 'paste',
      label: 'Pegar',
      title: 'Pegar (Ctrl+V)',
      icon: <Icon.Paste />,
      disabled: !canWrite || !hasClipboard,
      onClick: () => void pasteInto(location.path),
    },
    {
      id: 'rename',
      label: 'Renombrar',
      title: 'Cambiar nombre (F2)',
      icon: <Icon.Rename />,
      disabled: selection.length !== 1 || !canWrite,
      onClick: startRename,
    },
    {
      id: 'delete',
      label: 'Eliminar',
      title: 'Eliminar (Supr)',
      icon: <Icon.Delete />,
      disabled: none || !canDelete,
      onClick: () => askDelete(false),
    },
    {
      id: 'download',
      label: 'Descargar',
      icon: <Icon.Download />,
      disabled: !selection.some((e) => e.type === 'file'),
      onClick: download,
    },
  ];

  // ---- render ---------------------------------------------------------------
  const segs = pathSegments(location.path);
  const folderName = segs.length ? segs[segs.length - 1]! : (share?.name ?? '');
  const describeLoc = (l?: Location) => (l ? describe(l) : undefined);
  const showNav = narrow ? navOverlay : prefs.showNav;

  let body: ReactNode;
  if (sharesQ.isPending) body = <Skeleton />;
  else if (sharesQ.isError)
    body = (
      <PaneMessage
        title="No se pudieron cargar los recursos compartidos"
        detail={errorMessage(sharesQ.error)}
        onRetry={() => void sharesQ.refetch()}
      />
    );
  else if (shares.length === 0) body = <PaneMessage title="No tiene acceso a ningún recurso compartido." />;
  else if (inTrash && share) body = <TrashView share={share} />;
  else if (searching)
    body = (
      <SearchView
        scopeName={folderName}
        shareName={share?.name ?? location.share}
        query={serverQuery!}
        data={searchQ.data}
        loading={searchQ.isFetching}
        error={searchQ.error}
        onOpen={open}
        onRetry={() => void searchQ.refetch()}
      />
    );
  else
    body = (
      <FileView
        label={folderName}
        entries={entries}
        view={prefs.view}
        selected={sel.selected}
        focused={sel.focus}
        renaming={renaming}
        cutPaths={cutPaths}
        dropTarget={drop?.zone === 'pane' ? drop.key : null}
        sortKey={prefs.sortKey}
        sortDir={prefs.sortDir}
        columns={prefs.columns}
        listRef={listRef}
        idPrefix={idPrefix}
        empty={
          listQ.isPending ? (
            <Skeleton />
          ) : listQ.isError && !listQ.data ? (
            <PaneMessage
              title="No se puede acceder a esta ubicación"
              detail={errorMessage(listQ.error)}
              onRetry={() => void listQ.refetch()}
            />
          ) : (
            <div className="wfb-empty">
              {search ? 'Ningún elemento coincide con la búsqueda.' : 'Esta carpeta está vacía.'}
            </div>
          )
        }
        onSort={(k) => prefs.setSort(k)}
        onResizeColumn={prefs.setColumnWidth}
        onItemClick={onItemClick}
        onItemOpen={open}
        onItemContextMenu={(entry, e) => {
          focusList();
          if (!sel.selected.has(entry.path)) {
            setSel({ selected: new Set([entry.path]), anchor: entry.path, focus: entry.path });
          }
          const multi = sel.selected.has(entry.path) && sel.selected.size > 1;
          setMenu({ x: e.clientX, y: e.clientY, kind: 'item', target: multi ? undefined : entry });
        }}
        onBackgroundContextMenu={(e) => {
          focusList();
          setSel((s) => ({ ...s, selected: new Set() }));
          setMenu({ x: e.clientX, y: e.clientY, kind: 'background' });
        }}
        onBackgroundClick={() => {
          focusList();
          setSel((s) => ({ ...s, selected: new Set() }));
        }}
        onRubberBand={(paths) =>
          setSel((s) => ({
            selected: new Set(paths),
            anchor: paths[0] ?? s.anchor,
            focus: paths[paths.length - 1] ?? s.focus,
          }))
        }
        onRenameCommit={(entry, name) => void commitRename(entry, name)}
        onRenameCancel={() => {
          setRenaming(null);
          focusList();
        }}
        onKeyDown={onListKeyDown}
        itemDragProps={itemDragProps}
        backgroundDropProps={dropProps(current, folderName, 'pane', '')}
      />
    );

  return (
    <div
      ref={rootRef}
      className={`wfb-explorer${narrow ? ' is-narrow' : ''}`}
      onKeyDown={onRootKeyDown}
      onDragOver={() => drop && setDrop(null)}
    >
      <CommandBar
        newItems={newItems}
        newDisabled={!canWrite}
        buttons={buttons}
        sortItems={sortItems}
        viewItems={viewItems}
        showDetails={prefs.showDetails}
        onToggleDetails={() => prefs.setShowDetails(!prefs.showDetails)}
        headerRight={headerRight}
      />
      <AddressBar
        shares={shares}
        location={location}
        share={share}
        canBack={nav.canBack}
        canForward={nav.canForward}
        backLabel={describeLoc(nav.backTarget)}
        forwardLabel={describeLoc(nav.forwardTarget)}
        search={search}
        onSearch={setSearch}
        onSearchSubmit={submitSearch}
        searchDisabled={inTrash}
        onBack={nav.back}
        onForward={nav.forward}
        onUp={goUp}
        onRefresh={refresh}
        onNavigate={navigate}
        navToggleVisible={narrow}
        onToggleNav={() => setNavOverlay((v) => !v)}
      />
      <div className="wfb-body">
        {showNav && (
          <>
            {narrow && <div className="wfb-nav-scrim" onClick={() => setNavOverlay(false)} />}
            <NavTree
              shares={shares}
              current={location}
              expanded={expanded}
              dropTarget={drop?.zone === 'tree' ? drop.key : null}
              onToggle={(key, force) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  const openNow = force ?? !next.has(key);
                  if (openNow) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
              onNavigate={navigate}
              trashShares={trashShares}
              dropProps={(loc, name) => dropProps(loc, name, 'tree', nodeKey(loc.share, loc.path))}
            />
          </>
        )}
        <main className="wfb-main" aria-busy={listQ.isFetching || undefined}>
          {body}
        </main>
        {prefs.showDetails && share && (
          <DetailsPane
            share={share}
            folderName={folderName}
            folderPath={location.path}
            itemCount={allEntries.length}
            selection={selection}
            renderPreview={renderPreview}
            onClose={() => prefs.setShowDetails(false)}
          />
        )}
      </div>
      <StatusBar
        total={
          inTrash
            ? (trashQ.data?.items.length ?? 0)
            : searching
              ? (searchQ.data?.results.length ?? 0)
              : entries.length
        }
        selection={selection}
        readOnly={!!share && !canWrite}
        view={prefs.view}
        onView={prefs.setView}
      />

      <input
        ref={uploadRef}
        type="file"
        multiple
        hidden
        data-testid="upload-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void ops.upload(current, files);
        }}
      />

      {menu && (
        <Menu
          items={menuItems(menu)}
          x={menu.x}
          y={menu.y}
          label={menu.kind === 'item' ? 'Acciones del elemento' : 'Acciones de la carpeta'}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmDelete && (
        <DeleteDialog
          items={confirmDelete.items}
          permanent={confirmDelete.permanent}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void doDelete()}
        />
      )}
      {ops.dialogs}
      <TransferPanel />
      {drop && (
        <div className="wfb-drop-hint" style={{ left: drop.x + 14, top: drop.y + 18 }} aria-hidden="true">
          {drop.label}
        </div>
      )}
      <Toaster />
    </div>
  );
}

function DeleteDialog({
  items,
  permanent,
  onCancel,
  onConfirm,
}: {
  items: FileEntry[];
  permanent: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const what = items.length === 1 ? `«${items[0]!.name}»` : `estos ${items.length} elementos`;
  const title = permanent
    ? items.length === 1
      ? items[0]!.type === 'directory'
        ? 'Eliminar carpeta'
        : 'Eliminar archivo'
      : 'Eliminar varios elementos'
    : 'Mover a la papelera';
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button
            type="button"
            className={`wfb-btn ${permanent ? 'is-danger' : 'is-primary'}`}
            data-autofocus=""
            onClick={onConfirm}
          >
            {permanent ? 'Eliminar' : 'Mover a la papelera'}
          </button>
          <button type="button" className="wfb-btn" onClick={onCancel}>
            Cancelar
          </button>
        </>
      }
    >
      <p>
        {permanent
          ? `¿Está seguro de que desea eliminar permanentemente ${what}? Esta acción no se puede deshacer.`
          : `¿Está seguro de que desea mover ${what} a la papelera?`}
      </p>
    </Dialog>
  );
}

function Skeleton() {
  return (
    <div className="wfb-skeleton" role="status" aria-label="Cargando">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="wfb-skeleton-row" style={{ animationDelay: `${i * 60}ms` }}>
          <span className="wfb-skeleton-icon" />
          <span className="wfb-skeleton-bar" style={{ width: `${30 + ((i * 37) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

function PaneMessage({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="wfb-pane-message" role="alert">
      <Icon.Warning size={32} />
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
      {onRetry && (
        <button type="button" className="wfb-btn" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}
