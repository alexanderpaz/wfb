import type { User } from '@wfb/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { MemoryStore } from '../src/lib/kv.js';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env });
}

export const alice: User = {
  id: 'ldap:alice',
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  groups: ['staff'],
  provider: 'ldap',
};

export async function createTestApp(
  opts: { env?: Record<string, string>; user?: User; config?: Config } = {},
) {
  return buildApp({
    config: opts.config ?? testConfig(opts.env),
    services: { kv: new MemoryStore(), prisma: null },
    testUser: opts.user,
  });
}
