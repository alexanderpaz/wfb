import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import './auth.css';

const PROVIDER_LABEL = { ldap: 'LDAP', ad: 'Active Directory', oidc: 'Authentik' } as const;

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** Account button for the title bar: name, groups tooltip and sign out. */
export function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const groupsText = user.groups.length ? `Grupos: ${user.groups.join(', ')}` : 'Sin grupos';

  async function onLogout() {
    setLeaving(true);
    await logout();
  }

  return (
    <div className="wfb-usermenu" ref={rootRef}>
      <button
        type="button"
        className="wfb-usermenu__button"
        title={`${user.displayName}\n${groupsText}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wfb-avatar" aria-hidden="true">
          {initials(user.displayName)}
        </span>
        <span className="wfb-usermenu__name">{user.displayName}</span>
      </button>
      {open && (
        <div id={menuId} className="wfb-usermenu__panel" role="dialog" aria-label="Cuenta">
          <div className="wfb-usermenu__identity">
            <span className="wfb-avatar wfb-avatar--lg" aria-hidden="true">
              {initials(user.displayName)}
            </span>
            <div>
              <div className="wfb-usermenu__display">{user.displayName}</div>
              <div className="wfb-usermenu__meta">{user.email ?? user.username}</div>
              <div className="wfb-usermenu__meta">{PROVIDER_LABEL[user.provider]}</div>
            </div>
          </div>
          <div className="wfb-usermenu__groups">
            <div className="wfb-usermenu__label">Grupos</div>
            {user.groups.length ? (
              <ul>
                {user.groups.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            ) : (
              <p className="wfb-usermenu__meta">Sin grupos</p>
            )}
          </div>
          <button type="button" className="wfb-btn" onClick={() => void onLogout()} disabled={leaving}>
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}
