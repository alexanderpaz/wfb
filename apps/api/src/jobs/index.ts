import fp from 'fastify-plugin';
import type { ModuleOptions } from '../lib/module.js';

/**
 * Advanced operations module: background jobs (SSE), trash, search and resumable uploads.
 * Placeholder — implemented by the Ops agent (Phase 3).
 */
export default fp<ModuleOptions>(async () => {}, { name: 'wfb-ops', dependencies: ['wfb-files'] });
