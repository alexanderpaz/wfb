import type { User } from '@wfb/contracts';
import { Client, InvalidCredentialsError, type Entry, type SearchOptions } from 'ldapts';
import type { Config } from '../config.js';
import { attrValues, buildFilter, cnFromDn, escapeFilterValue, firstAttr } from './ldap-utils.js';

export type DirectoryConfig = NonNullable<Config['directory']>;

/** The subset of the ldapts client used here, so tests can provide fakes. */
export interface LdapClient {
  startTLS(options?: { rejectUnauthorized?: boolean }): Promise<void>;
  bind(dn: string, password?: string): Promise<void>;
  search(baseDn: string, options: SearchOptions): Promise<{ searchEntries: Entry[] }>;
  unbind(): Promise<void>;
}

export type LdapClientFactory = (cfg: DirectoryConfig) => LdapClient;

interface Logger {
  warn(obj: object, msg: string): void;
}

/** Thrown when the directory cannot be reached or the service account is misconfigured. */
export class DirectoryUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super('Directory unavailable');
  }
}

export const CONNECT_TIMEOUT_MS = 5_000;
export const OPERATION_TIMEOUT_MS = 10_000;

export const defaultClientFactory: LdapClientFactory = (cfg) =>
  new Client({
    url: cfg.url,
    connectTimeout: CONNECT_TIMEOUT_MS,
    timeout: OPERATION_TIMEOUT_MS,
    tlsOptions: { rejectUnauthorized: cfg.tlsRejectUnauthorized },
  });

const isInvalidCredentials = (err: unknown) =>
  err instanceof InvalidCredentialsError ||
  (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 49);

function attr(entry: Entry, name: string) {
  const lower = name.toLowerCase();
  const key = Object.keys(entry).find((k) => k.toLowerCase() === lower);
  return key ? entry[key] : undefined;
}

async function connect(cfg: DirectoryConfig, factory: LdapClientFactory): Promise<LdapClient> {
  const client = factory(cfg);
  if (cfg.startTls) await client.startTLS({ rejectUnauthorized: cfg.tlsRejectUnauthorized });
  return client;
}

async function safeUnbind(client: LdapClient | null) {
  try {
    await client?.unbind();
  } catch {
    // connection may already be closed
  }
}

async function groupCnsFromSearch(client: LdapClient, baseDn: string, filter: string): Promise<string[]> {
  const { searchEntries } = await client.search(baseDn, { scope: 'sub', filter, attributes: ['cn'] });
  return searchEntries.map((e) => firstAttr(attr(e, 'cn')) ?? cnFromDn(e.dn)).filter((v): v is string => !!v);
}

async function resolveGroups(
  client: LdapClient,
  cfg: DirectoryConfig,
  entry: Entry,
  log: Logger | undefined,
): Promise<string[]> {
  const groups = new Set<string>();
  for (const dn of attrValues(attr(entry, cfg.groupAttribute))) {
    const cn = cnFromDn(dn);
    if (cn) groups.add(cn);
  }
  const dn = escapeFilterValue(entry.dn);
  if (groups.size === 0) {
    try {
      const filter = `(|(member=${dn})(uniqueMember=${dn}))`;
      for (const cn of await groupCnsFromSearch(client, cfg.baseDn, filter)) groups.add(cn);
    } catch (err) {
      log?.warn({ err }, 'ldap group membership search failed');
    }
  }
  if (cfg.kind === 'ad') {
    try {
      const filter = `(member:1.2.840.113556.1.4.1941:=${dn})`;
      for (const cn of await groupCnsFromSearch(client, cfg.baseDn, filter)) groups.add(cn);
    } catch (err) {
      log?.warn({ err }, 'ad nested group search failed');
    }
  }
  return [...groups].sort();
}

function toUser(cfg: DirectoryConfig, entry: Entry, inputUsername: string, groups: string[]): User {
  const username = (
    firstAttr(attr(entry, 'sAMAccountName')) ??
    firstAttr(attr(entry, 'uid')) ??
    inputUsername
  ).toLowerCase();
  return {
    id: `${cfg.kind}:${username}`,
    username,
    displayName: firstAttr(attr(entry, 'displayName')) ?? firstAttr(attr(entry, 'cn')) ?? username,
    email: firstAttr(attr(entry, 'mail')) ?? null,
    groups,
    provider: cfg.kind,
  };
}

/**
 * Authenticates against LDAP / Active Directory.
 * Returns null for bad credentials or unknown/ambiguous users and throws
 * DirectoryUnavailableError for infrastructure problems.
 */
export async function authenticateDirectory(
  cfg: DirectoryConfig,
  username: string,
  password: string,
  opts: { clientFactory?: LdapClientFactory; log?: Logger } = {},
): Promise<User | null> {
  if (!username || !password) return null;
  const factory = opts.clientFactory ?? defaultClientFactory;
  // With AD and no service account the user binds with its UPN and searches as itself.
  const upnBind = cfg.kind === 'ad' && !cfg.bindDn && !!cfg.adDomain;

  let client: LdapClient | null = null;
  let userClient: LdapClient | null = null;
  try {
    try {
      client = await connect(cfg, factory);
    } catch (err) {
      throw new DirectoryUnavailableError(err);
    }

    if (upnBind) {
      try {
        await client.bind(`${username}@${cfg.adDomain}`, password);
      } catch (err) {
        if (isInvalidCredentials(err)) return null;
        throw new DirectoryUnavailableError(err);
      }
    } else if (cfg.bindDn) {
      try {
        await client.bind(cfg.bindDn, cfg.bindPassword ?? '');
      } catch (err) {
        throw new DirectoryUnavailableError(err);
      }
    }

    const filter = buildFilter(upnBind ? '(sAMAccountName={{username}})' : cfg.userFilter, username);
    let entries: Entry[];
    try {
      const result = await client.search(cfg.baseDn, {
        scope: 'sub',
        filter,
        sizeLimit: 2,
        attributes: ['dn', 'cn', 'uid', 'sAMAccountName', 'displayName', 'mail', cfg.groupAttribute],
      });
      entries = result.searchEntries;
    } catch (err) {
      if (err instanceof Error && err.name === 'SizeLimitExceededError') return null;
      throw new DirectoryUnavailableError(err);
    }
    if (entries.length !== 1) return null;
    const entry = entries[0]!;

    if (!upnBind) {
      try {
        userClient = await connect(cfg, factory);
      } catch (err) {
        throw new DirectoryUnavailableError(err);
      }
      try {
        await userClient.bind(entry.dn, password);
      } catch (err) {
        if (isInvalidCredentials(err)) return null;
        throw new DirectoryUnavailableError(err);
      }
    }

    const groups = await resolveGroups(client, cfg, entry, opts.log);
    return toUser(cfg, entry, username, groups);
  } finally {
    await safeUnbind(userClient);
    await safeUnbind(client);
  }
}
