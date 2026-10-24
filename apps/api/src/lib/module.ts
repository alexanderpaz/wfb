import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import type { KeyValueStore } from './kv.js';

export interface Services {
  kv: KeyValueStore;
  prisma: PrismaClient | null;
}

/** Options every feature module (auth, files, preview, jobs...) receives. */
export interface ModuleOptions {
  config: Config;
  services: Services;
}
