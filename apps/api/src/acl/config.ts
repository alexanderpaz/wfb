import { Permission } from '@wfb/contracts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const HOME_SHARE_ID = 'home';

const Permissions = z.array(Permission).transform((perms) => [...new Set(perms)]);

const AclEntry = z.union([
  z.object({ group: z.string().trim().min(1), permissions: Permissions }).strict(),
  z.object({ user: z.string().trim().min(1), permissions: Permissions }).strict(),
]);
export type AclEntry = z.infer<typeof AclEntry>;

const ShareDefSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'id must be a lowercase slug (a-z, 0-9, "-", "_")'),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    path: z.string().min(1),
    visibility: z.enum(['public', 'private']),
    permissions: Permissions.default([]),
    acl: z.array(AclEntry).default([]),
  })
  .strict();

const HomeDefSchema = z
  .object({
    enabled: z.boolean().default(false),
    root: z.string().min(1).optional(),
    name: z.string().trim().min(1).default('Mi carpeta'),
    permissions: Permissions.default(['read', 'write', 'delete']),
  })
  .strict();

const SharesFileSchema = z
  .object({
    shares: z.array(ShareDefSchema).default([]),
    home: HomeDefSchema.optional(),
  })
  .strict();

export interface ShareDef {
  id: string;
  name: string;
  description: string | null;
  /** Absolute path of the share root on disk. */
  path: string;
  visibility: 'public' | 'private';
  permissions: Permission[];
  acl: AclEntry[];
}

export interface HomeDef {
  name: string;
  /** Absolute directory containing one folder per user. */
  root: string;
  permissions: Permission[];
}

export interface SharesConfig {
  shares: ShareDef[];
  home: HomeDef | null;
}

export class SharesConfigError extends Error {
  constructor(file: string, reason: string) {
    super(`Invalid shares config ${file}: ${reason}`);
    this.name = 'SharesConfigError';
  }
}

/**
 * Validates the parsed YAML content of a shares file. Relative paths are
 * resolved against `cwd`. `homeRootOverride` (HOME_ROOT env) wins over `home.root`.
 */
export function parseSharesConfig(
  raw: unknown,
  opts: { file: string; cwd?: string; homeRootOverride?: string },
): SharesConfig {
  const cwd = opts.cwd ?? process.cwd();
  const result = SharesFileSchema.safeParse(raw ?? {});
  if (!result.success) {
    const reason = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SharesConfigError(opts.file, reason);
  }
  const data = result.data;

  const seen = new Set<string>();
  for (const share of data.shares) {
    if (seen.has(share.id)) throw new SharesConfigError(opts.file, `duplicate share id "${share.id}"`);
    seen.add(share.id);
  }

  let home: HomeDef | null = null;
  if (data.home?.enabled) {
    if (seen.has(HOME_SHARE_ID)) {
      throw new SharesConfigError(opts.file, `share id "${HOME_SHARE_ID}" is reserved when home is enabled`);
    }
    const root = opts.homeRootOverride ?? data.home.root;
    if (!root)
      throw new SharesConfigError(opts.file, 'home.root (or HOME_ROOT) is required when home is enabled');
    home = { name: data.home.name, root: path.resolve(cwd, root), permissions: data.home.permissions };
  }

  return {
    shares: data.shares.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? null,
      path: path.resolve(cwd, s.path),
      visibility: s.visibility,
      permissions: s.permissions,
      acl: s.acl,
    })),
    home,
  };
}

/** Reads and validates a shares YAML file. Throws `SharesConfigError` (or ENOENT). */
export function loadSharesConfig(
  file: string,
  opts: { cwd?: string; homeRootOverride?: string } = {},
): SharesConfig {
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new SharesConfigError(file, (err as Error).message);
  }
  return parseSharesConfig(raw, { file, ...opts });
}
