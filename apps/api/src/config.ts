import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['true', '1', 'yes'].includes(v)));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public URL. Coolify provides it through SERVICE_URL_APP / SERVICE_FQDN_APP. */
  APP_URL: optionalString,
  SERVICE_URL_APP: optionalString,
  SERVICE_FQDN_APP: optionalString,
  WEB_DIST: optionalString,

  SESSION_SECRET: optionalString,
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  DATABASE_URL: optionalString,
  REDIS_URL: optionalString,

  DIRECTORY_KIND: z.enum(['ldap', 'ad', 'none']).default('none'),
  DIRECTORY_LABEL: optionalString,
  LDAP_URL: optionalString,
  LDAP_BIND_DN: optionalString,
  LDAP_BIND_PASSWORD: optionalString,
  LDAP_BASE_DN: optionalString,
  LDAP_USER_FILTER: optionalString,
  LDAP_GROUP_ATTRIBUTE: z.string().default('memberOf'),
  LDAP_START_TLS: bool(false),
  LDAP_TLS_REJECT_UNAUTHORIZED: bool(true),
  AD_DOMAIN: optionalString,

  OIDC_ISSUER: optionalString,
  OIDC_CLIENT_ID: optionalString,
  OIDC_CLIENT_SECRET: optionalString,
  OIDC_SCOPES: z.string().default('openid profile email groups'),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_LABEL: z.string().default('Authentik'),

  SHARES_CONFIG: z.string().default('./config/shares.yaml'),
  HOME_ROOT: optionalString,
  TRASH_DIR_NAME: z.string().default('.wfb-trash'),
  DATA_DIR: z.string().default('./.data'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(1024),
  SYNC_TRANSFER_LIMIT_MB: z.coerce.number().nonnegative().default(50),
  OFFICE_PREVIEW: bool(false),
  SOFFICE_PATH: z.string().default('soffice'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  isProd: boolean;
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  appUrl: string;
  webDist: string | undefined;
  session: { secret: string; ttlSeconds: number; secureCookie: boolean };
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  directory: {
    kind: 'ldap' | 'ad';
    label: string;
    url: string;
    bindDn: string | undefined;
    bindPassword: string | undefined;
    baseDn: string;
    userFilter: string;
    groupAttribute: string;
    startTls: boolean;
    tlsRejectUnauthorized: boolean;
    adDomain: string | undefined;
  } | null;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string | undefined;
    scopes: string;
    groupsClaim: string;
    label: string;
    redirectUri: string;
  } | null;
  storage: {
    sharesConfig: string;
    homeRoot: string | undefined;
    trashDirName: string;
    dataDir: string;
    maxUploadBytes: number;
    syncTransferLimitBytes: number;
  };
  preview: { office: boolean; sofficePath: string };
  loginRateLimitPerMinute: number;
}

function normalizeUrl(value: string): string {
  const withScheme = /^https?:\/\//.test(value) ? value : `https://${value}`;
  return withScheme.split(',')[0]!.replace(/\/+$/, '');
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = EnvSchema.parse(source);
  const isProd = env.NODE_ENV === 'production';
  const rawUrl = env.APP_URL ?? env.SERVICE_URL_APP ?? env.SERVICE_FQDN_APP ?? `http://localhost:${env.PORT}`;
  const appUrl = normalizeUrl(rawUrl);

  if (isProd && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
  }

  let directory: Config['directory'] = null;
  if (env.DIRECTORY_KIND !== 'none') {
    if (!env.LDAP_URL || !env.LDAP_BASE_DN) {
      throw new Error('LDAP_URL and LDAP_BASE_DN are required when DIRECTORY_KIND is ldap or ad');
    }
    const kind = env.DIRECTORY_KIND;
    directory = {
      kind,
      label: env.DIRECTORY_LABEL ?? (kind === 'ad' ? 'Active Directory' : 'LDAP'),
      url: env.LDAP_URL,
      bindDn: env.LDAP_BIND_DN,
      bindPassword: env.LDAP_BIND_PASSWORD,
      baseDn: env.LDAP_BASE_DN,
      userFilter:
        env.LDAP_USER_FILTER ?? (kind === 'ad' ? '(sAMAccountName={{username}})' : '(uid={{username}})'),
      groupAttribute: env.LDAP_GROUP_ATTRIBUTE,
      startTls: env.LDAP_START_TLS,
      tlsRejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED,
      adDomain: env.AD_DOMAIN,
    };
  }

  const oidc: Config['oidc'] =
    env.OIDC_ISSUER && env.OIDC_CLIENT_ID
      ? {
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          scopes: env.OIDC_SCOPES,
          groupsClaim: env.OIDC_GROUPS_CLAIM,
          label: env.OIDC_LABEL,
          redirectUri: `${appUrl}/api/auth/oidc/callback`,
        }
      : null;

  return {
    env: env.NODE_ENV,
    isProd,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    appUrl,
    webDist: env.WEB_DIST,
    session: {
      secret: env.SESSION_SECRET ?? 'dev-insecure-session-secret-change-me',
      ttlSeconds: Math.round(env.SESSION_TTL_HOURS * 3600),
      secureCookie: appUrl.startsWith('https://'),
    },
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    directory,
    oidc,
    storage: {
      sharesConfig: env.SHARES_CONFIG,
      homeRoot: env.HOME_ROOT,
      trashDirName: env.TRASH_DIR_NAME,
      dataDir: env.DATA_DIR,
      maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
      syncTransferLimitBytes: env.SYNC_TRANSFER_LIMIT_MB * 1024 * 1024,
    },
    preview: { office: env.OFFICE_PREVIEW, sofficePath: env.SOFFICE_PATH },
    loginRateLimitPerMinute: env.LOGIN_RATE_LIMIT_PER_MINUTE,
  };
}
