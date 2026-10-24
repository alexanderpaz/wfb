import {
  API_PREFIX,
  CSRF_HEADER,
  DirectoryLoginRequest,
  SESSION_COOKIE,
  type AuthProvidersResponse,
  type MeResponse,
  type OkResponse,
  type User,
} from '@wfb/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { requireUser } from '../lib/auth-context.js';
import { HttpError, notFound, unauthenticated } from '../lib/errors.js';
import type { ModuleOptions } from '../lib/module.js';
import { parse } from '../lib/validate.js';
import { authenticateDirectory, DirectoryUnavailableError } from './directory.js';
import { OidcError, OidcService } from './oidc.js';
import { persistUser } from './persist.js';
import { checkLoginRateLimit } from './rate-limit.js';
import { safeEqual, SessionStore, type Session } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session loaded from the session cookie, if any. */
    authSession: Session | null;
  }
}

export const INVALID_CREDENTIALS_MESSAGE = 'Usuario o contraseña incorrectos';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DIRECTORY_LOGIN_PATH = `${API_PREFIX}/auth/ldap/login`;
const OIDC_LOGIN_PATH = `${API_PREFIX}/auth/oidc/login`;
const CSRF_EXEMPT = new Set([DIRECTORY_LOGIN_PATH]);

const pathOf = (url: string) => url.split('?')[0]!;
const isApiPath = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);

/**
 * Auth module: server-side sessions, CSRF protection, LDAP/AD and OIDC login.
 */
export default fp<ModuleOptions>(
  async (app, { config, services }) => {
    const { kv, prisma } = services;
    const sessions = new SessionStore(kv, config.session.ttlSeconds);
    const oidc = config.oidc ? new OidcService(config.oidc, kv, !config.isProd) : null;

    const cookieOptions = {
      signed: true,
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: config.session.secureCookie,
    };

    app.decorateRequest('authSession', null);

    app.addHook('onRequest', async (request) => {
      const raw = request.cookies[SESSION_COOKIE];
      if (raw) {
        const unsigned = request.unsignCookie(raw);
        const session = unsigned.valid && unsigned.value ? await sessions.get(unsigned.value) : null;
        request.authSession = session;
        request.user = session?.user ?? null;
      }

      const path = pathOf(request.url);
      if (!request.authSession || SAFE_METHODS.has(request.method) || !isApiPath(path)) return;
      if (CSRF_EXEMPT.has(path)) return;
      const header = request.headers[CSRF_HEADER];
      const token = Array.isArray(header) ? header[0] : header;
      if (!token || !safeEqual(token, request.authSession.csrfToken)) {
        throw new HttpError('CSRF', 'Missing or invalid CSRF token');
      }
    });

    /** Starts a fresh session (new id and CSRF token) to prevent session fixation. */
    async function startSession(request: FastifyRequest, reply: FastifyReply, user: User) {
      if (request.authSession) await sessions.destroy(request.authSession.id);
      const session = await sessions.create(user);
      request.authSession = session;
      request.user = user;
      reply.setCookie(SESSION_COOKIE, session.id, { ...cookieOptions, maxAge: config.session.ttlSeconds });
      return session;
    }

    app.get(`${API_PREFIX}/auth/providers`, async (): Promise<AuthProvidersResponse> => ({
      directory: config.directory ? { kind: config.directory.kind, label: config.directory.label } : null,
      oidc: config.oidc ? { label: config.oidc.label, loginUrl: OIDC_LOGIN_PATH } : null,
    }));

    app.post(DIRECTORY_LOGIN_PATH, async (request, reply): Promise<MeResponse> => {
      const directory = config.directory;
      if (!directory) throw notFound('Directory login is not enabled');
      const { username, password } = parse(DirectoryLoginRequest, request.body);
      await checkLoginRateLimit(kv, config.loginRateLimitPerMinute, request.ip, username);

      let user: User | null;
      try {
        user = await authenticateDirectory(directory, username, password, { log: request.log });
      } catch (err) {
        if (err instanceof DirectoryUnavailableError) {
          request.log.error({ err: err.cause }, 'directory unavailable');
          throw new HttpError('INTERNAL', 'El servicio de directorio no está disponible');
        }
        throw err;
      }
      if (!user) {
        request.log.info({ username, ip: request.ip }, 'directory login failed');
        throw unauthenticated(INVALID_CREDENTIALS_MESSAGE);
      }

      const session = await startSession(request, reply, user);
      await persistUser(prisma, user, user.username, request.log);
      request.log.info({ username: user.username, provider: user.provider }, 'login');
      return { user, csrfToken: session.csrfToken };
    });

    app.get(OIDC_LOGIN_PATH, async (request, reply) => {
      if (!oidc) throw notFound('OIDC login is not enabled');
      const { returnTo } = (request.query ?? {}) as { returnTo?: unknown };
      try {
        return reply.redirect(await oidc.authorizationUrl(returnTo));
      } catch (err) {
        request.log.error({ err: err instanceof OidcError ? err.cause : err }, 'oidc login failed');
        return reply.redirect('/?authError=oidc_unavailable');
      }
    });

    app.get(`${API_PREFIX}/auth/oidc/callback`, async (request, reply) => {
      if (!oidc) throw notFound('OIDC login is not enabled');
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '';
      try {
        const { user, subject, returnTo } = await oidc.handleCallback(query);
        await startSession(request, reply, user);
        await persistUser(prisma, user, subject, request.log);
        request.log.info({ username: user.username, provider: user.provider }, 'login');
        return reply.redirect(returnTo);
      } catch (err) {
        const code = err instanceof OidcError ? err.code : 'oidc_failed';
        request.log.warn(
          { err: err instanceof OidcError ? (err.cause ?? err) : err, code },
          'oidc callback failed',
        );
        return reply.redirect(`/?authError=${code}`);
      }
    });

    app.post(`${API_PREFIX}/auth/logout`, async (request, reply): Promise<OkResponse> => {
      requireUser(request);
      if (request.authSession) await sessions.destroy(request.authSession.id);
      request.authSession = null;
      request.user = null;
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get(`${API_PREFIX}/auth/me`, async (request): Promise<MeResponse> => {
      const user = requireUser(request);
      return { user, csrfToken: request.authSession!.csrfToken };
    });
  },
  { name: 'wfb-auth' },
);
