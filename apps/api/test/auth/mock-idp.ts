import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

interface Grant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });

/**
 * Minimal OpenID Provider (discovery, JWKS, token, userinfo) mimicking
 * Authentik's issuer layout. The authorization step is simulated with `authorize()`.
 */
export class MockIdp {
  issuer = '';
  clientSecret: string | undefined = 's3cret';
  /** Number of upcoming discovery requests that fail with 500. */
  failDiscovery = 0;
  discoveryRequests = 0;
  userinfo: Record<string, unknown> = {};
  tokenRequests: { auth: string | undefined; params: URLSearchParams }[] = [];

  private server: Server | null = null;
  private grants = new Map<string, Grant>();
  private tokens = new Map<string, Record<string, unknown>>();
  private privateKey!: CryptoKey;
  private jwk!: JWK;

  async start(): Promise<this> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => {
      this.handle(req)
        .then(({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        })
        .catch((err: Error) => {
          res.writeHead(500);
          res.end(err.message);
        });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${port}/application/o/wfb/`;
    return this;
  }

  async stop() {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** Simulates the user approving the login at the IdP; returns the authorization code. */
  authorize(authorizationUrl: string, claims: Record<string, unknown>): string {
    const url = new URL(authorizationUrl);
    const code = randomBytes(16).toString('hex');
    this.grants.set(code, {
      clientId: url.searchParams.get('client_id')!,
      redirectUri: url.searchParams.get('redirect_uri')!,
      codeChallenge: url.searchParams.get('code_challenge')!,
      nonce: url.searchParams.get('nonce')!,
      claims,
    });
    return code;
  }

  private url(path: string) {
    return new URL(path, this.issuer).toString();
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const path = new URL(req.url!, this.issuer).pathname;
    const base = new URL(this.issuer).pathname;
    if (path === `${base}.well-known/openid-configuration`) {
      this.discoveryRequests++;
      if (this.failDiscovery > 0) {
        this.failDiscovery--;
        return { status: 500, body: { error: 'boom' } };
      }
      return {
        status: 200,
        body: {
          issuer: this.issuer,
          authorization_endpoint: this.url('authorize/'),
          token_endpoint: this.url('token/'),
          userinfo_endpoint: this.url('userinfo/'),
          jwks_uri: this.url('jwks/'),
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        },
      };
    }
    if (path === `${base}jwks/`) return { status: 200, body: { keys: [this.jwk] } };
    if (path === `${base}token/` && req.method === 'POST') return this.token(req);
    if (path === `${base}userinfo/`) {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const claims = token ? this.tokens.get(token) : undefined;
      if (!claims) return { status: 401, body: { error: 'invalid_token' } };
      return { status: 200, body: { sub: claims.sub, ...this.userinfo } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  private async token(req: IncomingMessage) {
    const params = new URLSearchParams(await readBody(req));
    const auth = req.headers.authorization;
    this.tokenRequests.push({ auth, params });
    const grant = this.grants.get(params.get('code') ?? '');
    const invalid = (error: string) => ({ status: 400, body: { error } });
    if (!grant) return invalid('invalid_grant');
    this.grants.delete(params.get('code')!);

    if (this.clientSecret) {
      const expected = `Basic ${Buffer.from(`${grant.clientId}:${this.clientSecret}`).toString('base64')}`;
      const viaPost =
        params.get('client_id') === grant.clientId && params.get('client_secret') === this.clientSecret;
      if (auth !== expected && !viaPost) return { status: 401, body: { error: 'invalid_client' } };
    } else if (params.get('client_id') !== grant.clientId) {
      return { status: 401, body: { error: 'invalid_client' } };
    }
    if (params.get('redirect_uri') !== grant.redirectUri) return invalid('invalid_grant');
    const verifier = params.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== grant.codeChallenge) return invalid('invalid_grant');

    const idToken = await new SignJWT({ nonce: grant.nonce, ...grant.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(this.issuer)
      .setAudience(grant.clientId)
      .setSubject(String(grant.claims.sub))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.privateKey);
    const accessToken = randomBytes(16).toString('hex');
    this.tokens.set(accessToken, grant.claims);
    return {
      status: 200,
      body: { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken },
    };
  }
}
