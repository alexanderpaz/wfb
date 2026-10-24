import type { User } from '@wfb/contracts';
import * as client from 'openid-client';
import type { Config } from '../config.js';
import type { KeyValueStore } from '../lib/kv.js';

export type OidcConfig = NonNullable<Config['oidc']>;

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `oidc:${state}`;

interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

/** Error codes appended as `/?authError=<code>` when the OIDC callback fails. */
export type OidcErrorCode = 'oidc_denied' | 'oidc_state' | 'oidc_failed' | 'oidc_unavailable';

export class OidcError extends Error {
  constructor(
    public readonly code: OidcErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Only same-origin relative paths are accepted as post-login destinations
 * (open-redirect protection). Anything else falls back to '/'.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(value)) return '/';
  try {
    const base = 'http://wfb.invalid';
    const url = new URL(value, base);
    if (url.origin !== base) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

function claimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function groupsFromClaim(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim() !== ''))].sort();
}

export function userFromClaims(claims: Record<string, unknown>, groupsClaim: string): User {
  const sub = claimString(claims.sub);
  const username = (claimString(claims.preferred_username) ?? claimString(claims.email) ?? sub)?.toLowerCase();
  if (!username) throw new OidcError('oidc_failed', 'OIDC claims without a usable username');
  return {
    id: `oidc:${username}`,
    username,
    displayName: claimString(claims.name) ?? claimString(claims.nickname) ?? username,
    email: claimString(claims.email) ?? null,
    groups: groupsFromClaim(claims[groupsClaim]),
    provider: 'oidc',
  };
}

export interface OidcCallbackResult {
  user: User;
  subject: string;
  returnTo: string;
}

/** Authorization code + PKCE flow against the configured issuer (Authentik). */
export class OidcService {
  private configuration: Promise<client.Configuration> | null = null;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly kv: KeyValueStore,
    private readonly allowInsecure: boolean,
  ) {}

  /** Lazy discovery; a failed discovery is retried on the next call. */
  private getConfiguration(): Promise<client.Configuration> {
    if (!this.configuration) {
      const auth = this.cfg.clientSecret ? client.ClientSecretBasic(this.cfg.clientSecret) : client.None();
      const insecure = this.allowInsecure && this.cfg.issuer.startsWith('http://');
      this.configuration = client
        .discovery(new URL(this.cfg.issuer), this.cfg.clientId, undefined, auth, {
          execute: insecure ? [client.allowInsecureRequests] : [],
          timeout: 10,
        })
        .catch((err: unknown) => {
          this.configuration = null;
          throw new OidcError('oidc_unavailable', 'OIDC discovery failed', err);
        });
    }
    return this.configuration;
  }

  async authorizationUrl(returnTo: unknown): Promise<string> {
    const config = await this.getConfiguration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const pending: PendingLogin = { codeVerifier, nonce, returnTo: safeReturnTo(returnTo) };
    await this.kv.set(stateKey(state), JSON.stringify(pending), STATE_TTL_SECONDS);
    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: this.cfg.redirectUri,
        scope: this.cfg.scopes,
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      .toString();
  }

  /** `query` is the raw query string of the callback request (without '?'). */
  async handleCallback(query: string): Promise<OidcCallbackResult> {
    const params = new URLSearchParams(query);
    const state = params.get('state');
    const pendingRaw = state ? await this.kv.get(stateKey(state)) : null;
    if (state) await this.kv.del(stateKey(state));
    if (params.get('error')) throw new OidcError('oidc_denied', `IdP returned ${params.get('error')}`);
    if (!state || !pendingRaw) throw new OidcError('oidc_state', 'Unknown or expired OIDC state');
    const pending = JSON.parse(pendingRaw) as PendingLogin;

    const config = await this.getConfiguration();
    const currentUrl = new URL(this.cfg.redirectUri);
    currentUrl.search = params.toString();

    let claims: Record<string, unknown>;
    try {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims) throw new Error('missing id_token');
      claims = { ...idClaims };
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, idClaims.sub);
        claims = { ...claims, ...info };
      } catch {
        // userinfo is optional: the id token claims are enough
      }
    } catch (err) {
      throw new OidcError('oidc_failed', 'OIDC code exchange failed', err);
    }

    return {
      user: userFromClaims(claims, this.cfg.groupsClaim),
      subject: String(claims.sub),
      returnTo: pending.returnTo,
    };
  }
}
