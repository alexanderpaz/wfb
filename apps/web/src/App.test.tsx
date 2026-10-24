import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from './App';
import { resetMockDb } from './mocks/db';
import { server } from './mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => resetMockDb());
afterAll(() => server.close());

function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('shows the explorer with the user menu when authenticated', async () => {
    renderApp();
    expect(await screen.findByRole('treeitem', { name: 'Ingeniería' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ana García/ })).toBeInTheDocument();
  });

  it('returns to the login page after signing out', async () => {
    renderApp();
    await screen.findByRole('treeitem', { name: 'Ingeniería' });
    await userEvent.click(screen.getByRole('button', { name: /Ana García/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('button', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });
});
