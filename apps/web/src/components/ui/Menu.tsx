import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

export type MenuItem =
  | { type: 'separator'; id?: string }
  | {
      type?: 'item';
      id?: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      /** Renders as a radio item (aria-checked) when defined. */
      checked?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
    };

type ActionItem = Exclude<MenuItem, { type: 'separator' }>;

const isAction = (i: MenuItem): i is ActionItem => i.type !== 'separator';
const isEnabled = (i: MenuItem): i is ActionItem => isAction(i) && !i.disabled;

export interface MenuProps {
  items: MenuItem[];
  /** Viewport coordinates of the top-left corner (adjusted to stay inside the viewport). */
  x: number;
  y: number;
  onClose: () => void;
  label?: string;
  /** Alternative x position used when the menu does not fit to the right (submenus). */
  flipX?: number;
}

/**
 * Popup menu (context menu, dropdown and submenus). Keyboard: arrows, Home/End,
 * Enter/Space, Right/Left for submenus, Esc closes, Tab closes. Closes on outside click.
 */
export function Menu(props: MenuProps) {
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // Captured during the first render, before the menu list grabs focus.
  const restoreFocus = useRef<Element | null>(document.activeElement);
  const [onClose] = useState(() => () => closeRef.current());

  useEffect(() => {
    const previous = restoreFocus.current;
    const onDown = (e: MouseEvent) => {
      // Triggers toggle their own menu on click, so they must not close it on mousedown.
      if (!(e.target instanceof Element) || !e.target.closest('[data-wfb-menu], [data-wfb-menu-trigger]')) {
        onClose();
      }
    };
    const onBlur = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <MenuList {...props} onClose={onClose} depth={0} onCloseAll={onClose} />,
    document.body,
  );
}

function MenuList({
  items,
  x,
  y,
  flipX,
  label,
  depth,
  autoFocus = true,
  onClose,
  onCloseAll,
}: MenuProps & { depth: number; autoFocus?: boolean; onCloseAll: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [active, setActive] = useState(() => items.findIndex(isEnabled));
  const [sub, setSub] = useState<{
    index: number;
    x: number;
    y: number;
    flipX: number;
    focus: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    if (left + width > vw - 4) left = flipX !== undefined ? flipX - width : vw - width - 4;
    let top = y;
    if (top + height > vh - 4) top = Math.max(4, vh - height - 4);
    setPos({ left: Math.max(4, left), top: Math.max(4, top), ready: true });
  }, [x, y, flipX]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const openSub = (index: number, focus: boolean) => {
    const item = items[index];
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!item || !isEnabled(item) || !item.submenu || !el) return;
    const r = el.getBoundingClientRect();
    setSub({ index, x: r.right - 2, y: r.top - 4, flipX: r.left + 2, focus });
  };

  const activate = (index: number) => {
    const item = items[index];
    if (!item || !isEnabled(item)) return;
    if (item.submenu) return openSub(index, true);
    onCloseAll();
    item.onSelect?.();
  };

  const move = (delta: number) => {
    const n = items.length;
    for (let step = 1; step <= n; step++) {
      const i = (((active + delta * step) % n) + n) % n;
      if (isEnabled(items[i]!)) return setActive(i);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(items.findIndex(isEnabled));
        break;
      case 'End':
        e.preventDefault();
        setActive(items.length - 1 - [...items].reverse().findIndex(isEnabled));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(active);
        break;
      case 'ArrowRight':
        e.preventDefault();
        openSub(active, true);
        break;
      case 'ArrowLeft':
        if (depth > 0) {
          e.preventDefault();
          onClose();
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (depth > 0) onClose();
        else onCloseAll();
        break;
      case 'Tab':
        e.preventDefault();
        onCloseAll();
        break;
    }
  };

  const subItem = sub ? items[sub.index] : undefined;

  return (
    <>
      <div
        ref={ref}
        data-wfb-menu=""
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className="wfb-menu"
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        aria-activedescendant={active >= 0 ? `wfb-menu-${depth}-${active}` : undefined}
        onKeyDown={onKeyDown}
        onMouseEnter={() => {
          if (depth > 0) ref.current?.focus({ preventScroll: true });
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          if (!isAction(item))
            return <div key={item.id ?? `sep-${index}`} role="separator" className="wfb-menu-sep" />;
          const radio = item.checked !== undefined;
          return (
            <div
              key={item.id ?? item.label}
              id={`wfb-menu-${depth}-${index}`}
              data-index={index}
              role={radio ? 'menuitemradio' : 'menuitem'}
              aria-checked={radio ? item.checked : undefined}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? sub?.index === index : undefined}
              className={`wfb-menu-item${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => {
                if (item.disabled) return;
                setActive(index);
                if (item.submenu) openSub(index, false);
                else setSub(null);
              }}
              onClick={() => activate(index)}
            >
              <span className="wfb-menu-icon">
                {radio ? item.checked ? <span className="wfb-menu-dot" /> : null : item.icon}
              </span>
              <span className="wfb-menu-label">{item.label}</span>
              {item.shortcut && <span className="wfb-menu-shortcut">{item.shortcut}</span>}
              {item.submenu && (
                <svg
                  className="wfb-menu-chevron"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              )}
            </div>
          );
        })}
      </div>
      {sub && subItem && isAction(subItem) && subItem.submenu && (
        <MenuList
          key={sub.index}
          items={subItem.submenu}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          label={subItem.label}
          depth={depth + 1}
          autoFocus={sub.focus}
          onClose={() => {
            setSub(null);
            ref.current?.focus({ preventScroll: true });
          }}
          onCloseAll={onCloseAll}
        />
      )}
    </>
  );
}
