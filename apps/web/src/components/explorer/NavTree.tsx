import type { FileEntry, Share } from '@wfb/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../../api/client';
import type { DropProps } from './FileView';
import { FileIcon, Icon, ShareIcon } from './icons';
import { listKey } from './useFileOps';
import type { Location } from './useNavigation';

export const nodeKey = (share: string, path: string) => `${share}:${path}`;

export interface NavTreeProps {
  shares: Share[];
  current: Location;
  expanded: ReadonlySet<string>;
  dropTarget: string | null;
  onToggle: (key: string, open?: boolean) => void;
  onNavigate: (loc: Location) => void;
  dropProps: (loc: Location, name: string) => DropProps;
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Left navigation pane: shares as roots with lazily loaded folders. */
export function NavTree(props: NavTreeProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const active = document.activeElement as HTMLElement | null;
    const idx = items.findIndex((el) => el === active);
    if (idx < 0) return;
    const el = items[idx]!;
    const key = el.dataset.key!;
    const focus = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'ArrowDown':
        handled();
        focus(idx + 1);
        break;
      case 'ArrowUp':
        handled();
        focus(idx - 1);
        break;
      case 'Home':
        handled();
        focus(0);
        break;
      case 'End':
        handled();
        focus(items.length - 1);
        break;
      case 'ArrowRight':
        handled();
        if (el.getAttribute('aria-expanded') === 'false') props.onToggle(key, true);
        else if (el.getAttribute('aria-expanded') === 'true') focus(idx + 1);
        break;
      case 'ArrowLeft': {
        handled();
        if (el.getAttribute('aria-expanded') === 'true') props.onToggle(key, false);
        else {
          const parent = el.parentElement?.closest<HTMLElement>('[role="treeitem"]');
          parent?.focus();
        }
        break;
      }
      case 'Enter':
      case ' ':
        handled();
        props.onNavigate({ share: el.dataset.share!, path: el.dataset.path! });
        break;
    }
  };

  const currentKey = nodeKey(props.current.share, props.current.path);

  // Roving tabindex: keep one treeitem tabbable even if the current folder is collapsed away.
  useEffect(() => {
    const tree = ref.current;
    if (!tree || tree.querySelector('[role="treeitem"][tabindex="0"]')) return;
    const fallback =
      tree.querySelector<HTMLElement>(
        `[role="treeitem"][data-key="${CSS.escape(nodeKey(props.current.share, '/'))}"]`,
      ) ?? tree.querySelector<HTMLElement>('[role="treeitem"]');
    fallback?.setAttribute('tabindex', '0');
  });

  return (
    <nav className="wfb-nav" aria-label="Panel de navegación">
      <div ref={ref} role="tree" aria-label="Recursos compartidos" className="wfb-tree" onKeyDown={onKeyDown}>
        {props.shares.map((share) => (
          <TreeNode
            key={share.id}
            {...props}
            share={share}
            path="/"
            name={share.name}
            level={1}
            currentKey={currentKey}
          />
        ))}
      </div>
    </nav>
  );
}

function TreeNode(
  props: NavTreeProps & {
    share: Share;
    path: string;
    name: string;
    level: number;
    currentKey: string;
  },
) {
  const { share, path, name, level, expanded, currentKey } = props;
  const key = nodeKey(share.id, path);
  const isOpen = expanded.has(key);
  const isCurrent = key === currentKey;
  const children = useQuery({
    queryKey: listKey(share.id, path),
    queryFn: () => api.list({ share: share.id, path }),
    enabled: isOpen,
    select: (d) =>
      d.entries.filter((e) => e.type === 'directory').sort((a, b) => collator.compare(a.name, b.name)),
  });
  const folders: FileEntry[] | undefined = children.data;
  const leaf = folders !== undefined && folders.length === 0;

  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={isCurrent}
      aria-expanded={leaf ? undefined : isOpen}
      aria-label={name}
      data-key={key}
      data-share={share.id}
      data-path={path}
      tabIndex={isCurrent ? 0 : -1}
      className="wfb-treeitem"
    >
      <div
        className={`wfb-tree-row${isCurrent ? ' is-current' : ''}${props.dropTarget === key ? ' is-drop-target' : ''}`}
        style={{ paddingLeft: 4 + (level - 1) * 16 }}
        onClick={() => props.onNavigate({ share: share.id, path })}
        {...props.dropProps({ share: share.id, path }, name)}
      >
        <span
          className={`wfb-tree-twisty${leaf ? ' is-leaf' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle(key);
          }}
          aria-hidden="true"
        >
          {isOpen ? <Icon.ChevronDown size={12} /> : <Icon.ChevronRight size={12} />}
        </span>
        {path === '/' ? (
          <ShareIcon visibility={share.visibility} size={18} />
        ) : (
          <FileIcon kind="folder" size={18} />
        )}
        <span className="wfb-tree-label">{name}</span>
        {children.isFetching && !folders && <span className="wfb-spinner is-small" aria-hidden="true" />}
      </div>
      {isOpen && folders && folders.length > 0 && (
        <div role="group">
          {folders.map((f) => (
            <TreeNode key={f.path} {...props} path={f.path} name={f.name} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
