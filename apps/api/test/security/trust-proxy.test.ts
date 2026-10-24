import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, testConfig } from '../helpers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function clientIp(env: Record<string, string>, forwardedFor: string): Promise<string> {
  app = await createTestApp({ env });
  app.get('/__ip', async (request) => ({ ip: request.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/__ip',
    remoteAddress: '10.0.0.2',
    headers: { 'x-forwarded-for': forwardedFor },
  });
  return res.json<{ ip: string }>().ip;
}

describe('TRUST_PROXY', () => {
  it('parses booleans and address lists, rejecting hop counts', () => {
    expect(testConfig().trustProxy).toBe(false);
    expect(testConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(testConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => testConfig({ TRUST_PROXY: '1' })).toThrow(/hop count/);
    expect(testConfig({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toBe('10.0.0.0/8, 127.0.0.1');
  });

  it('ignores X-Forwarded-For by default so the client IP cannot be spoofed', async () => {
    expect(await clientIp({}, '1.2.3.4')).toBe('10.0.0.2');
  });

  it('behind a trusted proxy takes the address the proxy saw, not a client-supplied one', async () => {
    expect(await clientIp({ TRUST_PROXY: '10.0.0.0/8' }, '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For from an untrusted sender', async () => {
    expect(await clientIp({ TRUST_PROXY: '172.16.0.0/12' }, '203.0.113.7')).toBe('10.0.0.2');
  });
});
