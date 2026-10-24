import type { IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { genReqId, loggerOptions, loggingOptions, redactUrl } from '../src/lib/logger.js';

const prodConfig = (env: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), LOG_LEVEL: 'info', ...env });

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  return { lines, stream };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogLine = Record<string, any>;

const fakeReq = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as IncomingMessage;

describe('logger options', () => {
  it('is disabled in tests and JSON with the configured level otherwise', () => {
    expect(loggerOptions(loadConfig({ NODE_ENV: 'test' }))).toBe(false);
    const opts = loggerOptions(prodConfig({ LOG_LEVEL: 'warn' }));
    expect(opts).toMatchObject({ level: 'warn' });
    expect(opts && opts.transport).toBeUndefined();
  });

  it('never enables pretty output in production', () => {
    const opts = loggerOptions(prodConfig({ LOG_PRETTY: 'true' }));
    expect(opts && opts.transport).toBeUndefined();
  });

  it('redacts credentials in headers and nested fields', () => {
    const opts = loggerOptions(prodConfig());
    if (!opts) throw new Error('expected logger options');
    const { lines, stream } = capture();
    const log = pino({ level: opts.level, redact: opts.redact }, stream);
    log.info(
      {
        req: {
          headers: { cookie: 'wfb_sid=abc', authorization: 'Bearer t', 'x-csrf-token': 'c', accept: '*/*' },
        },
        res: { headers: { 'set-cookie': 'wfb_sid=abc' } },
        password: 'p1',
        body: { username: 'alice', password: 'p2' },
        directory: { config: { bindPassword: 'p3' } },
        oidc: { clientSecret: 's', csrfToken: 'c' },
      },
      'login',
    );
    const line = lines[0] as LogLine;
    const serialized = JSON.stringify(line);
    for (const secret of ['wfb_sid=abc', 'Bearer t', '"p1"', '"p2"', '"p3"', '"s"', '"c"']) {
      expect(serialized).not.toContain(secret);
    }
    expect(line.req.headers.accept).toBe('*/*');
    expect(line.req.headers.cookie).toBe('[Redacted]');
    expect(line.body.username).toBe('alice');
    expect(line.body.password).toBe('[Redacted]');
  });

  it('strips OIDC codes and tokens from logged URLs', () => {
    expect(redactUrl('/api/auth/oidc/callback?code=abc&state=xyz&iss=https%3A%2F%2Fak')).toBe(
      '/api/auth/oidc/callback?code=[Redacted]&state=[Redacted]&iss=https%3A%2F%2Fak',
    );
    expect(redactUrl('/api/files?path=/a')).toBe('/api/files?path=/a');
  });
});

describe('request ids', () => {
  it('honors a well-formed x-request-id and generates one otherwise', () => {
    expect(genReqId(fakeReq({ 'x-request-id': 'abc-123' }))).toBe('abc-123');
    expect(genReqId(fakeReq({ 'x-request-id': ['first', 'second'] }))).toBe('first');
    const generated = genReqId(fakeReq({ 'x-request-id': 'bad id\n{"x":1}' }));
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(genReqId(fakeReq({}))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs the propagated request id and a redacted url', async () => {
    const config = prodConfig();
    const { lines, stream } = capture();
    const { logger, ...rest } = loggingOptions(config);
    const app = Fastify({ ...rest, logger: { ...(logger as object), stream } });
    app.get('/api/auth/oidc/callback', async (request) => ({ id: request.id }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=secret-code&state=s',
      headers: { 'x-request-id': 'req-42', cookie: 'wfb_sid=abc' },
    });
    await app.close();
    expect(res.json()).toEqual({ id: 'req-42' });
    const incoming = lines.find((l) => l.msg === 'incoming request') as LogLine;
    expect(incoming.reqId).toBe('req-42');
    expect(incoming.req.url).toBe('/api/auth/oidc/callback?code=[Redacted]&state=[Redacted]');
    expect(JSON.stringify(lines)).not.toContain('secret-code');
    expect(JSON.stringify(lines)).not.toContain('wfb_sid=abc');
  });
});
