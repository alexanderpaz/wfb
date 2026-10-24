import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { resetMockDb } from '../../mocks/db';
import { server } from '../../mocks/server';
import { useClipboard } from '../../stores/clipboard';
import { useExplorerPrefs } from '../../stores/explorerPrefs';
import { useToasts } from '../../stores/toasts';
import { Explorer, type ExplorerProps } from './index';

/** Registers MSW + state resets for a test file. */
export function setupMockApi() {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  beforeEach(() => {
    resetMockDb();
    localStorage.clear();
    useExplorerPrefs.getState().reset();
    useClipboard.getState().clear();
    useToasts.setState({ toasts: [] });
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    cleanup();
    server.resetHandlers();
    server.events.removeAllListeners();
  });
  afterAll(() => server.close());
}

export function renderExplorer(props: ExplorerProps = {}, url?: string) {
  if (url) window.history.replaceState(null, '', url);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Explorer {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, user, queryClient };
}
