import fp from 'fastify-plugin';
import type { ModuleOptions } from '../lib/module.js';
import { registerSearchRoutes } from '../search/routes.js';
import { SearchService } from '../search/service.js';
import { registerTrashRoutes } from '../trash/routes.js';
import { TrashService } from '../trash/service.js';
import { registerUploadRoutes } from '../uploads/routes.js';
import { UploadService } from '../uploads/service.js';
import { JobManager } from './manager.js';
import { registerJobRoutes } from './routes.js';
import { TransferJobs } from './transfer.js';

export { JobManager } from './manager.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Background jobs (large copy/move). */
    jobs: JobManager;
    trash: TrashService;
    uploads: UploadService;
  }
}

const HOUR = 60 * 60 * 1000;

/** Advanced operations module: background jobs (SSE), trash, search and resumable uploads. */
export default fp<ModuleOptions>(
  async (app, { config, services }) => {
    const jobs = new JobManager();
    const trash = new TrashService(app.files, { trashDirName: config.storage.trashDirName });
    const search = new SearchService(app.files);
    const uploads = new UploadService(app.files, services.kv, {
      dataDir: config.storage.dataDir,
      maxUploadBytes: config.storage.maxUploadBytes,
    });

    app.files.trash = trash;
    app.files.jobs = new TransferJobs(app.files, jobs, {
      syncLimitBytes: config.storage.syncTransferLimitBytes,
    });
    app.decorate('jobs', jobs);
    app.decorate('trash', trash);
    app.decorate('uploads', uploads);

    const sweep = () => void uploads.cleanupStale().catch((err) => app.log.warn({ err }, 'upload cleanup failed'));
    const timer = setInterval(sweep, HOUR);
    timer.unref();
    if (config.env !== 'test') sweep();
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await jobs.close();
    });

    await app.register(async (scoped) => {
      registerJobRoutes(scoped, jobs);
      registerTrashRoutes(scoped, trash);
      registerSearchRoutes(scoped, search);
      registerUploadRoutes(scoped, uploads);
    });
  },
  { name: 'wfb-ops', dependencies: ['wfb-files'] },
);
