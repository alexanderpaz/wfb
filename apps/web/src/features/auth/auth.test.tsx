import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthProvidersResponse, MeResponse } from '@wfb/contracts';
import { CSRF_HEADER } from '@wfb/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from '../../api/client';
import { AuthGate, AuthProvider, UserMenu } from './index';
import { initials } from './UserMenu';

const alice: MeResponse = {
  user: {
    id: 'ldap:alice',
    username: 'alice',
    displayName: 'Alice Admin',
    email: 'alice@example.org',
    groups: ['engineering', 'staff'],
    provider: 'ldap',
  },
  csrfToken: 'csrf-alice',
};

const bothProviders: AuthProvidersResponse = {
  directory: { kind: 'ldap', label: 'LDAP corporativo' },
  oidc: { label: 'Authentik', loginUrl: '/api/auth/oidc/login' },
};

const apiError = (status: number, code: string, message = code) =>
  HttpResponse.json({ error: { code, message } }, { status });

let session: MeResponse | null;
let providers: AuthProvidersResponse;
const csrfSeen: (string | null)[] = [];

const server = setupServer(
  http.get('/api/auth/providers', () => HttpResponse.json(providers)),
  http.get('/api/auth/me', () => (session ? HttpResponse.json(session) : apiError(401, 'UNAUTHENTICATED'))),
  http.post('/api/auth/ldap/login', async ({ request }) => {
    const body = (await request.json()) as { username: string; password: string };
    if (body.username === 'alice' && body.password === 'alice123') {
      session = alice;
      return HttpResponse.json(alice);
    }
    if (body.username === 'spam') return apiError(429, 'RATE_LIMITED');
    return apiError(401, 'UNAUTHENTICATED', 'Usuario o contraseña incorrectos');
  }),
  http.post('/api/auth/logout', ({ request }) => {
    csrfSeen.push(request.headers.get(CSRF_HEADER));
    session = null;
    return HttpResponse.json({ ok: true });
  }),
  http.get('/api/shares', () =>
    session ? HttpResponse.json({ shares: [] }) : apiError(401, 'UNAUTHENTICATED'),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  session = null;
  providers = bothProviders;
  csrfSeen.length = 0;
  setCsrfToken(null);
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

function renderApp(props: { navigate?: (url: string) => void; onSignOut?: () => void } = {}) {
  return render(
    <AuthProvider {...props}>
      <AuthGate>
        <div>
          <p>Contenido privado</p>
          <UserMenu />
        </div>
      </AuthGate>
    </AuthProvider>,
  );
}

describe('AuthGate', () => {
  it('shows a spinner while loading and then the login page when anonymous', async () => {
    renderApp();
    expect(screen.getByRole('status', { name: 'Cargando…' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Explorador de archivos' })).toBeInTheDocument();
    expect(screen.queryByText('Contenido privado')).not.toBeInTheDocument();
    expect(screen.getByText('LDAP corporativo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Iniciar sesión con Authentik' })).toBeInTheDocument();
  });

  it('renders children when the session is valid and uses its csrf token', async () => {
    session = alice;
    renderApp();
    expect(await screen.findByText('Contenido privado')).toBeInTheDocument();
    await api.logout();
    expect(csrfSeen).toEqual(['csrf-alice']);
  });
});

describe('LoginPage', () => {
  it('logs in with the directory provider', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText('Usuario'), 'alice');
    await user.type(screen.getByLabelText('Contraseña'), 'alice123');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByText('Contenido privado')).toBeInTheDocument();
    await api.logout();
    expect(csrfSeen).toEqual(['csrf-alice']);
  });

  it('shows a loading state while submitting', async () => {
    let release!: () => void;
    server.use(
      http.post('/api/auth/ldap/login', async () => {
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json(alice);
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText('Usuario'), 'alice');
    await user.type(screen.getByLabelText('Contraseña'), 'x');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    const button = await screen.findByRole('button', { name: /Iniciando sesión/ });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Usuario')).toBeDisabled();
    release();
    expect(await screen.findByText('Contenido privado')).toBeInTheDocument();
  });

  it('shows bad credentials and clears the password', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText('Usuario'), 'alice');
    await user.type(screen.getByLabelText('Contraseña'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usuario o contraseña incorrectos.');
    expect(screen.getByLabelText('Contraseña')).toHaveValue('');
    expect(screen.getByLabelText('Usuario')).toHaveValue('alice');
  });

  it('shows a rate limit message', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText('Usuario'), 'spam');
    await user.type(screen.getByLabelText('Contraseña'), 'x');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Demasiados intentos');
  });

  it('validates empty fields locally', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe tu usuario y tu contraseña.');
  });

  it('shows the OIDC callback error from ?authError and removes it from the URL', async () => {
    window.history.replaceState(null, '', '/carpeta?authError=oidc_denied&x=1');
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('Se canceló el inicio de sesión');
    expect(window.location.search).toBe('?x=1');
    expect(window.location.pathname).toBe('/carpeta');
  });

  it('navigates to the OIDC login with the current path as returnTo', async () => {
    window.history.replaceState(null, '', '/compartido/docs');
    const navigate = vi.fn();
    const user = userEvent.setup();
    renderApp({ navigate });
    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión con Authentik' }));
    expect(navigate).toHaveBeenCalledWith('/api/auth/oidc/login?returnTo=%2Fcompartido%2Fdocs');
  });

  it('only offers the configured providers', async () => {
    providers = { directory: null, oidc: { label: 'SSO Empresa', loginUrl: '/api/auth/oidc/login' } };
    renderApp();
    expect(await screen.findByRole('button', { name: 'Iniciar sesión con SSO Empresa' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
  });

  it('explains when no login method is configured', async () => {
    providers = { directory: null, oidc: null };
    renderApp();
    expect(
      await screen.findByText(/No hay ningún método de inicio de sesión configurado/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Iniciar sesión/ })).not.toBeInTheDocument();
  });

  it('offers a retry when the server is unreachable', async () => {
    server.use(http.get('/api/auth/providers', () => HttpResponse.error()));
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText('No se pudo contactar con el servidor.')).toBeInTheDocument();
    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Usuario')).toBeInTheDocument();
  });
});

describe('session lifecycle', () => {
  it('returns to the login page when the session expires', async () => {
    session = alice;
    const onSignOut = vi.fn();
    renderApp({ onSignOut });
    await screen.findByText('Contenido privado');
    session = null;
    await expect(api.shares()).rejects.toThrow();
    expect(await screen.findByText('Tu sesión ha caducado. Vuelve a iniciar sesión.')).toBeInTheDocument();
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe('UserMenu', () => {
  it('shows the user, groups and signs out', async () => {
    session = alice;
    const user = userEvent.setup();
    renderApp();
    const button = await screen.findByRole('button', { name: /Alice Admin/ });
    expect(button).toHaveAttribute('title', expect.stringContaining('Grupos: engineering, staff'));
    await user.click(button);
    const panel = screen.getByRole('dialog', { name: 'Cuenta' });
    expect(within(panel).getByText('alice@example.org')).toBeInTheDocument();
    expect(within(panel).getByText('engineering')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByLabelText('Usuario')).toBeInTheDocument();
    expect(csrfSeen).toEqual(['csrf-alice']);
    expect(screen.queryByText('Tu sesión ha caducado. Vuelve a iniciar sesión.')).not.toBeInTheDocument();
    await waitFor(() => expect(session).toBeNull());
  });

  it('computes initials', () => {
    expect(initials('Alice Admin')).toBe('AA');
    expect(initials('carol')).toBe('CA');
    expect(initials('john.doe')).toBe('JD');
  });
});
