import { useEffect, useId, useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { loginErrorMessage, oidcErrorMessage } from './messages';
import './auth.css';

function readAuthErrorParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('authError');
  if (code) {
    params.delete('authError');
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
    );
  }
  return code;
}

export function FolderLogo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M4 12a4 4 0 0 1 4-4h10.3a4 4 0 0 1 2.8 1.2L24 12h16a4 4 0 0 1 4 4v2H4z" fill="#d89c1f" />
      <rect x="4" y="16" width="40" height="24" rx="4" fill="#f5c342" />
      <rect x="4" y="16" width="40" height="3" fill="#fbd96b" />
    </svg>
  );
}

export function Spinner({ label, size = 'md' }: { label?: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`wfb-spinner wfb-spinner--${size}`}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function LoginPage() {
  const { providers, providersError, sessionExpired, loginWithDirectory, loginWithOidc, refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = useId();
  const passId = useId();

  useEffect(() => {
    const code = readAuthErrorParam();
    if (code) setError(oidcErrorMessage(code));
  }, []);

  const directory = providers?.directory ?? null;
  const oidc = providers?.oidc ?? null;
  const busy = submitting || redirecting;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError('Escribe tu usuario y tu contraseña.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await loginWithDirectory(username.trim(), password);
    } catch (err) {
      setError(loginErrorMessage(err));
      setPassword('');
      setSubmitting(false);
    }
  }

  function onOidc() {
    setRedirecting(true);
    setError(null);
    loginWithOidc(window.location.pathname);
  }

  return (
    <div className="wfb-login">
      <main className="wfb-login__card" aria-labelledby="wfb-login-title">
        <header className="wfb-login__header">
          <FolderLogo />
          <h1 id="wfb-login-title" className="wfb-login__title">
            Explorador de archivos
          </h1>
          <p className="wfb-login__subtitle">Inicia sesión para acceder a tus carpetas</p>
        </header>

        {sessionExpired && !error && (
          <p className="wfb-alert wfb-alert--info" role="status">
            Tu sesión ha caducado. Vuelve a iniciar sesión.
          </p>
        )}
        {error && (
          <p className="wfb-alert wfb-alert--error" role="alert">
            {error}
          </p>
        )}

        {providersError && (
          <div className="wfb-login__empty">
            <p>No se pudo contactar con el servidor.</p>
            <button type="button" className="wfb-btn" onClick={() => void refresh()}>
              Reintentar
            </button>
          </div>
        )}

        {providers && !directory && !oidc && (
          <p className="wfb-login__empty">
            No hay ningún método de inicio de sesión configurado. Contacta con el administrador del sistema.
          </p>
        )}

        {directory && (
          <form
            className="wfb-login__form"
            onSubmit={onSubmit}
            noValidate
            aria-label={`Iniciar sesión con ${directory.label}`}
          >
            <p className="wfb-login__provider">
              Usa tu cuenta de <strong>{directory.label}</strong>
            </p>
            <div className="wfb-field">
              <label htmlFor={userId}>Usuario</label>
              <input
                id={userId}
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                value={username}
                disabled={busy}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="wfb-field">
              <label htmlFor={passId}>Contraseña</label>
              <input
                id={passId}
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="wfb-btn wfb-btn--primary" disabled={busy}>
              {submitting ? (
                <>
                  <Spinner size="sm" /> Iniciando sesión…
                </>
              ) : (
                'Iniciar sesión'
              )}
            </button>
          </form>
        )}

        {directory && oidc && (
          <div className="wfb-login__divider" role="separator">
            <span>o</span>
          </div>
        )}

        {oidc && (
          <button type="button" className="wfb-btn wfb-btn--oidc" onClick={onOidc} disabled={busy}>
            {redirecting ? <Spinner size="sm" /> : <KeyIcon />}
            {`Iniciar sesión con ${oidc.label}`}
          </button>
        )}
      </main>
    </div>
  );
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M10.5 1a4.5 4.5 0 0 0-4.3 5.8L1 12v3h3v-1.5h1.5V12H7l1.2-1.2A4.5 4.5 0 1 0 10.5 1zm1 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"
        fill="currentColor"
      />
    </svg>
  );
}
