import type { AuthProvidersResponse, User } from '@wfb/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, setCsrfToken, setUnauthenticatedHandler } from '../../api/client';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Null while loading or when the server could not be reached. */
  providers: AuthProvidersResponse | null;
  /** True when the provider list could not be loaded. */
  providersError: boolean;
  /** True when the user was signed out because the session expired. */
  sessionExpired: boolean;
  /** Rejects with ApiRequestError on bad credentials, rate limiting, etc. */
  loginWithDirectory(username: string, password: string): Promise<void>;
  /** Full-page navigation to the OIDC provider. */
  loginWithOidc(returnTo?: string): void;
  logout(): Promise<void>;
  /** Reloads session and providers (e.g. after a network error). */
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Called after logout or session expiry, e.g. to clear query caches. */
  onSignOut?: () => void;
  /** Defaults to `window.location.assign`; injectable for tests. */
  navigate?: (url: string) => void;
}

export function AuthProvider({ children, onSignOut, navigate }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [providers, setProviders] = useState<AuthProvidersResponse | null>(null);
  const [providersError, setProvidersError] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  const onSignOutRef = useRef(onSignOut);
  onSignOutRef.current = onSignOut;

  const signIn = useCallback((nextUser: User, csrfToken: string) => {
    setCsrfToken(csrfToken);
    setUser(nextUser);
    setSessionExpired(false);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    setStatus('anonymous');
    onSignOutRef.current?.();
  }, []);

  const refresh = useCallback(async () => {
    const [me, prov] = await Promise.allSettled([api.me(), api.providers()]);
    if (prov.status === 'fulfilled') {
      setProviders(prov.value);
      setProvidersError(false);
    } else {
      setProviders(null);
      setProvidersError(true);
    }
    if (me.status === 'fulfilled') signIn(me.value.user, me.value.csrfToken);
    else {
      setCsrfToken(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, [signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      if (statusRef.current === 'authenticated') setSessionExpired(true);
      signOut();
    });
    return () => setUnauthenticatedHandler(null);
  }, [signOut]);

  const loginWithDirectory = useCallback(
    async (username: string, password: string) => {
      const me = await api.login({ username, password });
      signIn(me.user, me.csrfToken);
    },
    [signIn],
  );

  const loginWithOidc = useCallback(
    (returnTo?: string) => {
      const url = api.oidcLoginUrl(returnTo ?? window.location.pathname);
      (navigate ?? ((u: string) => window.location.assign(u)))(url);
    },
    [navigate],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // the session is dropped locally even if the server call fails
    }
    setSessionExpired(false);
    signOut();
  }, [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      providers,
      providersError,
      sessionExpired,
      loginWithDirectory,
      loginWithOidc,
      logout,
      refresh,
    }),
    [
      status,
      user,
      providers,
      providersError,
      sessionExpired,
      loginWithDirectory,
      loginWithOidc,
      logout,
      refresh,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
