import { z } from 'zod';

export const AuthProviderKind = z.enum(['ldap', 'ad', 'oidc']);
export type AuthProviderKind = z.infer<typeof AuthProviderKind>;

export const User = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  groups: z.array(z.string()),
  provider: AuthProviderKind,
});
export type User = z.infer<typeof User>;

/** GET /api/auth/providers — which login methods the login screen must offer. */
export const AuthProvidersResponse = z.object({
  directory: z
    .object({
      kind: z.enum(['ldap', 'ad']),
      label: z.string(),
    })
    .nullable(),
  oidc: z
    .object({
      label: z.string(),
      loginUrl: z.string(),
    })
    .nullable(),
});
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponse>;

/** POST /api/auth/ldap/login — used for both LDAP and Active Directory. */
export const DirectoryLoginRequest = z.object({
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type DirectoryLoginRequest = z.infer<typeof DirectoryLoginRequest>;

/** GET /api/auth/me and response of a successful login. */
export const MeResponse = z.object({
  user: User,
  csrfToken: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;
