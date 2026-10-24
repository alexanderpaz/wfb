import fp from 'fastify-plugin';
import type { ModuleOptions } from '../lib/module.js';

/**
 * Preview module: thumbnails and renderable content.
 * Placeholder — implemented by the Previews agent (Phase 3).
 */
export default fp<ModuleOptions>(async () => {}, { name: 'wfb-preview', dependencies: ['wfb-files'] });
