import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config.js';

export const REQUEST_ID_HEADER = 'x-request-id';

const REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-csrf-token', 'proxy-authorization'];
const REDACT_FIELDS = [
  'password',
  'bindPassword',
  'clientSecret',
  'csrfToken',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
];

export const REDACT_PATHS = [
  ...REDACT_HEADERS.flatMap((h) => [`req.headers["${h}"]`, `res.headers["${h}"]`, `headers["${h}"]`]),
  ...REDACT_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`]),
];

/** Query parameters that carry credentials (OIDC callback, signed links). */
const SENSITIVE_QUERY = /([?&](?:code|state|token|access_token|id_token|session_state)=)[^&#]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SENSITIVE_QUERY, '$1[Redacted]');
}

const VALID_REQUEST_ID = /^[\w.:@/+=-]{1,128}$/;

/** Reuses a well-formed `x-request-id` from the proxy, otherwise generates one. */
export function genReqId(req: IncomingMessage): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

export function loggerOptions(config: Config): LoggerOptions | false {
  if (config.env === 'test') return false;
  const options: LoggerOptions = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    serializers: {
      req: (req: { method: string; url: string; host?: string; ip?: string; id?: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
        host: req.host,
        remoteAddress: req.ip,
      }),
    },
  };
  if (config.logPretty && !config.isProd && prettyAvailable()) {
    options.transport = {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  }
  return options;
}

/** Fastify options for logging and request correlation. */
export function loggingOptions(
  config: Config,
): Pick<FastifyServerOptions, 'logger' | 'genReqId' | 'requestIdHeader'> {
  // requestIdHeader is off so the raw header always goes through genReqId's validation.
  return { logger: loggerOptions(config), genReqId, requestIdHeader: false };
}
