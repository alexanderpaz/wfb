import type { HttpHandler } from 'msw';

/** MSW handlers implementing the contract in memory. Filled in by the UI agent (Phase 1). */
export const handlers: HttpHandler[] = [];
