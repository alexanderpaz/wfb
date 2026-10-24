import type { User } from '@wfb/contracts';
import * as client from 'openid-client';
import type { Config } from '../config.js';
import type { KeyValueStore } from '../lib/kv.js';
import { safeEqual } from './sessions.js';

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
 * Operator-facing explanation of a failed code exchange, for the `oidc callback failed` log line.
 * The browser only gets the generic `oidc_failed` code.
 */
export function oidcFailureHint(err: unknown): string | undefined {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e !== 'object') break;
    const { message, error, code, cause } = e as {
      message?: unknown;
      error?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    for (const v of [message, error, code]) if (typeof v === 'string') parts.push(v);
    if (cause && typeof cause === 'object' && 'alg' in cause) parts.push(`alg=${String(cause.alg)}`);
    e = cause;
  }
  const text = parts.join(' | ');
  if (/alg=HS\d+|unsupported JWS|JWT "alg"/.test(text)) {
    return 'The IdP signs ID tokens with a symmetric key (HS256), which is not supported. In Authentik select a certificate in Providers → <provider> → Signing Key.';
  }
  if (/invalid_client/.test(text)) {
    return 'The IdP rejected the client credentials: check OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_TOKEN_AUTH_METHOD (client_secret_post for Authentik).';
  }
  if (/invalid_grant/.test(text)) {
    return 'The IdP rejected the authorization code: redirect_uri not registered exactly, code reused/expired, or clock skew.';
  }
  if (/"iss"|issuer/i.test(text)) {
    return 'The ID token issuer does not match OIDC_ISSUER (it must match the provider issuer exactly, including the trailing slash).';
  }
  if (/"(exp|iat|nbf)"|timestamp/.test(text)) {
    return 'ID token time checks failed: synchronize the clocks (NTP) of the wfb and IdP servers.';
  }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|certificate|CERT_|self.signed/i.test(text)) {
    return 'The app cannot reach the IdP token endpoint (DNS, network or TLS). For a private CA set NODE_EXTRA_CA_CERTS.';
  }
  return undefined;
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
  const username = (
    claimString(claims.preferred_username) ??
    claimString(claims.email) ??
    sub
  )?.toLowerCase();
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
  /** Kept in the session for RP-initiated logout (`id_token_hint`). */
  idToken: string | undefined;
}

/** Authorization code + PKCE flow against the configured issuer (Authentik). */
export class OidcService {
  private configuration: Promise<client.Configuration> | null = null;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly kv: KeyValueStore,
    private readonly allowInsecure: boolean,
    /** Where the IdP sends the browser after an RP-initiated logout (APP_URL). */
    private readonly postLogoutRedirectUri: string,
  ) {}

  /** Lazy discovery; a failed discovery is retried on the next call. */
  private getConfiguration(): Promise<client.Configuration> {
    if (!this.configuration) {
      const secret = this.cfg.clientSecret;
      const auth = !secret
        ? client.None()
        : this.cfg.tokenAuthMethod === 'client_secret_basic'
          ? client.ClientSecretBasic(secret)
          : client.ClientSecretPost(secret);
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

  /**
   * Returns the IdP URL and the `state`, which the caller must bind to the
   * browser (cookie) and hand back to `handleCallback`.
   */
  async authorizationUrl(returnTo: unknown): Promise<{ url: string; state: string }> {
    const config = await this.getConfiguration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const pending: PendingLogin = { codeVerifier, nonce, returnTo: safeReturnTo(returnTo) };
    await this.kv.set(stateKey(state), JSON.stringify(pending), STATE_TTL_SECONDS);
    const url = client
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
    return { url, state };
  }

  /**
   * `query` is the raw query string of the callback request (without '?').
   * `browserState` is the state bound to the browser that started the login:
   * a callback carrying another state (login CSRF) is rejected.
   */
  async handleCallback(query: string, browserState: string | null): Promise<OidcCallbackResult> {
    const params = new URLSearchParams(query);
    const state = params.get('state');
    const pendingRaw = state ? await this.kv.get(stateKey(state)) : null;
    if (state) await this.kv.del(stateKey(state));
    if (params.get('error')) throw new OidcError('oidc_denied', `IdP returned ${params.get('error')}`);
    if (!state || !pendingRaw) throw new OidcError('oidc_state', 'Unknown or expired OIDC state');
    if (!browserState || !safeEqual(state, browserState)) {
      throw new OidcError('oidc_state', 'OIDC state was not started by this browser');
    }
    const pending = JSON.parse(pendingRaw) as PendingLogin;

    const config = await this.getConfiguration();
    const currentUrl = new URL(this.cfg.redirectUri);
    currentUrl.search = params.toString();

    let claims: Record<string, unknown>;
    let idToken: string | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims) throw new Error('missing id_token');
      idToken = tokens.id_token;
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
      idToken,
    };
  }

  /**
   * IdP logout URL (RP-initiated logout) or null when the IdP does not
   * advertise an `end_session_endpoint` or is unreachable.
   */
  async endSessionUrl(idToken: string | undefined): Promise<string | null> {
    let config: client.Configuration;
    try {
      config = await this.getConfiguration();
    } catch {
      return null;
    }
    if (!config.serverMetadata().end_session_endpoint) return null;
    const params: Record<string, string> = {
      post_logout_redirect_uri: this.postLogoutRedirectUri,
      client_id: this.cfg.clientId,
    };
    if (idToken) params.id_token_hint = idToken;
    return client.buildEndSessionUrl(config, params).toString();
  }
}
