import fp from 'fastify-plugin';
import type { ModuleOptions } from '../lib/module.js';

/**
 * Files module: shares (ACL), listing and file operations.
 * Placeholder from Phase 0 — implemented by the Storage/ACL agent (Phase 1).
 */
export default fp<ModuleOptions>(async () => {}, { name: 'wfb-files' });
