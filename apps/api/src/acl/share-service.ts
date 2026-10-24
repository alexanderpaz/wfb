import type { Permission, Share, User } from '@wfb/contracts';
import { statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { forbidden, notFound } from '../lib/errors.js';
import { HOME_SHARE_ID, loadSharesConfig, type SharesConfig } from './config.js';
import { effectivePermissions, isVisible } from './match.js';

export interface ResolvedShare {
  id: string;
  name: string;
  description: string | null;
  visibility: Share['visibility'];
  /** Absolute root directory on disk. */
  path: string;
  /** Effective permissions of the user on this share. */
  permissions: Permission[];
}

export interface ShareServiceOptions {
  /** Path of the shares YAML (relative to process.cwd()). */
  file: string;
  /** HOME_ROOT env override for `home.root`. */
  homeRoot?: string;
  /** Poll interval for config reload, 0 disables it. */
  reloadIntervalMs?: number;
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/** Folder name used for a user's home: lowercase, filesystem-safe, never empty or dot-only. */
export function homeDirName(username: string): string | null {
  const name = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '_')
    .replace(/^\.+/, '');
  return name === '' || name.length > 128 ? null : name;
}

const toShare = (s: ResolvedShare): Share => ({
  id: s.id,
  name: s.name,
  description: s.description,
  visibility: s.visibility,
  permissions: s.permissions,
});

export class ShareService {
  private config: SharesConfig = { shares: [], home: null };
  private readonly file: string;
  private signature: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ShareServiceOptions) {
    this.file = path.resolve(opts.file);
    this.loadInitial();
    if (opts.reloadIntervalMs !== 0) {
      this.timer = setInterval(() => void this.reloadIfChanged(), opts.reloadIntervalMs ?? 2000);
      this.timer.unref();
    }
  }

  /** Fails fast on invalid config. A missing file means "no shares" (logged). */
  private loadInitial() {
    try {
      const st = statSync(this.file);
      this.signature = `${st.mtimeMs}:${st.size}:${st.ino}`;
      this.config = loadSharesConfig(this.file, { homeRootOverride: this.opts.homeRoot });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.opts.log?.warn(`shares config ${this.file} not found; no shares are exposed`);
        return;
      }
      throw err;
    }
  }

  /** Reloads the config when the file changed; keeps the last good config on errors. */
  async reloadIfChanged(): Promise<boolean> {
    let signature: string;
    try {
      const st = await stat(this.file);
      signature = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return false;
    }
    if (signature === this.signature) return false;
    this.signature = signature;
    return this.reload();
  }

  /** Forces a reload. Returns false (and keeps the previous config) when invalid. */
  reload(): boolean {
    try {
      this.config = loadSharesConfig(this.file, { homeRootOverride: this.opts.homeRoot });
      this.opts.log?.info(`shares config reloaded (${this.config.shares.length} shares)`);
      return true;
    } catch (err) {
      this.opts.log?.error(`shares config reload failed, keeping previous config: ${(err as Error).message}`);
      return false;
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private resolveAll(user: User): ResolvedShare[] {
    const out: ResolvedShare[] = [];
    const { home } = this.config;
    const homeName = home ? homeDirName(user.username) : null;
    if (home && homeName) {
      out.push({
        id: HOME_SHARE_ID,
        name: home.name,
        description: null,
        visibility: 'home',
        path: path.join(home.root, homeName),
        permissions: home.permissions,
      });
    }
    for (const def of this.config.shares) {
      const permissions = effectivePermissions(def, user);
      if (!isVisible(def, permissions)) continue;
      out.push({
        id: def.id,
        name: def.name,
        description: def.description,
        visibility: def.visibility,
        path: def.path,
        permissions,
      });
    }
    return out;
  }

  listForUser(user: User): Share[] {
    return this.resolveAll(user).map(toShare);
  }

  /** Returns the share with effective permissions; 404 when not visible (no existence leak). */
  async get(user: User, shareId: string): Promise<ResolvedShare> {
    const share = this.resolveAll(user).find((s) => s.id === shareId);
    if (!share) throw notFound('Share not found');
    if (share.visibility === 'home') await mkdir(share.path, { recursive: true, mode: 0o750 });
    return share;
  }

  /** Like `get`, plus 403 when the permission is missing. */
  async assert(user: User, shareId: string, perm: Permission): Promise<ResolvedShare> {
    const share = await this.get(user, shareId);
    if (!share.permissions.includes(perm)) throw forbidden(`Missing "${perm}" permission on this share`);
    return share;
  }
}
