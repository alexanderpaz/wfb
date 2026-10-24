import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/** Node MSW server for vitest. Pair with `resetMockDb()` from `./db` between tests. */
export const server = setupServer(...handlers);
