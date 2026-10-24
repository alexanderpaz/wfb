import multipart from '@fastify/multipart';
import type { FileRef, Permission, User } from '@wfb/contracts';
import fp from 'fastify-plugin';
import { ShareService } from '../acl/share-service.js';
import type { ModuleOptions } from '../lib/module.js';
import { registerFileRoutes } from './routes.js';
import { FilesService, type ResolvedRef } from './service.js';

export type {
  ResolvedRef,
  TransferExecutor,
  TransferJobHandler,
  TransferPlan,
  TrashHandler,
} from './service.js';
export { FilesService } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shares visible to a user and their effective permissions (ACL). */
    shares: ShareService;
    /** File operations shared by routes and later modules (jobs, trash, preview). */
    files: FilesService;
    /**
     * Checks `perm` on the share (404 when invisible, 403 when missing) and
     * resolves the path safely inside it.
     */
    resolveRef(user: User, ref: FileRef, perm: Permission): Promise<ResolvedRef>;
  }
}

/** Files module: shares (ACL), listing and file operations. */
export default fp<ModuleOptions>(
  async (app, { config }) => {
    const shares = new ShareService({
      file: config.storage.sharesConfig,
      homeRoot: config.storage.homeRoot,
      reloadIntervalMs: config.env === 'test' ? 0 : 2000,
      log: {
        info: (msg) => app.log.info(msg),
        warn: (msg) => app.log.warn(msg),
        error: (msg) => app.log.error(msg),
      },
    });
    const files = new FilesService(shares, {
      trashDirName: config.storage.trashDirName,
      officePreview: config.preview.office,
    });

    app.decorate('shares', shares);
    app.decorate('files', files);
    app.decorate('resolveRef', (user: User, ref: FileRef, perm: Permission) =>
      files.resolveRef(user, ref, perm),
    );
    app.addHook('onClose', async () => shares.close());

    await app.register(async (scoped) => {
      await scoped.register(multipart, {
        limits: { fileSize: config.storage.maxUploadBytes, fields: 20, parts: 1100 },
      });
      registerFileRoutes(scoped, files, config);
    });
  },
  { name: 'wfb-files', dependencies: ['wfb-audit'] },
);
