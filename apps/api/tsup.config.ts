import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript sources; bundle them so the image only needs node_modules of the api.
  noExternal: ['@wfb/contracts'],
});
