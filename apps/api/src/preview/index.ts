import fp from 'fastify-plugin';
import path from 'node:path';
import type { ModuleOptions } from '../lib/module.js';
import { sweepCache } from './cache-sweeper.js';
import { OfficeConverter } from './office.js';
import { registerPreviewRoutes } from './routes.js';
import { ThumbnailService } from './thumbnails.js';

const MB = 1024 * 1024;
const DAY = 24 * 3600 * 1000;

/** Preview module: preview info, thumbnails (sharp) and renderable content (text, media, Office → PDF). */
export default fp<ModuleOptions>(
  async (app, { config }) => {
    const dataDir = path.resolve(config.storage.dataDir);
    const officeCacheDir = path.join(dataDir, 'office');
    const thumbnails = new ThumbnailService({
      cacheDir: path.join(dataDir, 'thumbs'),
      maxInputBytes: 50 * MB,
      maxInputPixels: 100_000_000,
      concurrency: 2,
    });
    const office = new OfficeConverter({
      enabled: config.preview.office,
      sofficePath: config.preview.sofficePath,
      cacheDir: officeCacheDir,
      timeoutMs: 60_000,
      maxInputBytes: 100 * MB,
    });

    if (config.env !== 'test') {
      const sweep = () => {
        for (const dir of [path.join(dataDir, 'thumbs'), officeCacheDir]) {
          sweepCache(dir, { maxAgeMs: 30 * DAY, maxTotalBytes: 2048 * MB })
            .then((r) => r.removed && app.log.info({ dir, ...r }, 'preview cache swept'))
            .catch((err) => app.log.warn({ err, dir }, 'preview cache sweep failed'));
        }
      };
      const timer = setInterval(sweep, 6 * 3600 * 1000);
      timer.unref();
      setTimeout(sweep, 60_000).unref();
      app.addHook('onClose', async () => clearInterval(timer));
    }

    await app.register(async (scoped) => {
      registerPreviewRoutes(scoped, config, { thumbnails, office, officeCacheDir });
    });
  },
  { name: 'wfb-preview', dependencies: ['wfb-files'] },
);
