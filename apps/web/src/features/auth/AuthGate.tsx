import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { LoginPage, Spinner } from './LoginPage';
import './auth.css';

/** Renders children only for authenticated users; otherwise the login screen. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="wfb-auth-loading">
        <Spinner label="Cargando…" />
      </div>
    );
  }
  if (status === 'anonymous') return <LoginPage />;
  return <>{children}</>;
}
