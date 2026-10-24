import type { Permission, User } from '@wfb/contracts';
import type { AclEntry, ShareDef } from './config.js';

/**
 * Canonical group key: lowercased CN. Accepts a bare name (`Finance`) or a DN
 * (`CN=Finance,OU=Groups,DC=corp`), so config and directory may use either.
 */
export function groupKey(group: string): string {
  const value = group.trim().toLowerCase();
  const match = /^cn\s*=\s*((?:\\.|[^,])+)/.exec(value);
  return (match ? match[1]!.replace(/\\(.)/g, '$1') : value).trim();
}

export function aclEntryMatches(entry: AclEntry, user: User, userGroups: Set<string>): boolean {
  if ('user' in entry) return entry.user.trim().toLowerCase() === user.username.trim().toLowerCase();
  return userGroups.has(groupKey(entry.group));
}

const ORDER: Permission[] = ['read', 'write', 'delete'];

/** Union of base permissions (public shares only) and every matching ACL entry. */
export function effectivePermissions(share: ShareDef, user: User): Permission[] {
  const groups = new Set(user.groups.map(groupKey));
  const perms = new Set<Permission>(share.visibility === 'public' ? share.permissions : []);
  for (const entry of share.acl) {
    if (aclEntryMatches(entry, user, groups)) entry.permissions.forEach((p) => perms.add(p));
  }
  return ORDER.filter((p) => perms.has(p));
}

export function isVisible(share: ShareDef, perms: Permission[]): boolean {
  return share.visibility === 'public' || perms.includes('read');
}
