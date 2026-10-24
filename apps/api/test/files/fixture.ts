import type { User } from '@wfb/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createTestApp, testConfig } from '../helpers.js';

export const users = {
  alice: {
    id: 'ldap:alice',
    username: 'alice',
    displayName: 'Alice',
    email: null,
    groups: ['staff'],
    provider: 'ldap',
  },
  bob: {
    id: 'ldap:bob',
    username: 'Bob',
    displayName: 'Bob',
    email: null,
    groups: ['CN=Engineering,OU=Groups,DC=corp,DC=local', 'staff'],
    provider: 'ad',
  },
  carol: {
    id: 'oidc:carol',
    username: 'carol',
    displayName: 'Carol',
    email: null,
    groups: [],
    provider: 'oidc',
  },
} satisfies Record<string, User>;

export function sharesYaml(root: string, extra = ''): string {
  return `
shares:
  - id: public
    name: Público
    description: Para todos
    path: ${root}/public
    visibility: public
    permissions: [read]
    acl:
      - group: STAFF
        permissions: [read, write]
  - id: eng
    name: Ingeniería
    path: ${root}/eng
    visibility: private
    acl:
      - group: cn=engineering,ou=groups,dc=corp,dc=local
        permissions: [read, write, delete]
  - id: finance
    name: Finanzas
    path: ${root}/finance
    visibility: private
    acl:
      - group: finance
        permissions: [read, write, delete]
      - user: ALICE
        permissions: [read]
  - id: dropbox
    name: Buzón
    path: ${root}/dropbox
    visibility: private
    acl:
      - user: carol
        permissions: [write]
${extra}`;
}

export interface Fixture {
  tmp: string;
  root: string;
  yamlPath: string;
  app(user?: User, env?: Record<string, string>): Promise<FastifyInstance>;
  file(rel: string, content?: string | Buffer): Promise<string>;
  dir(rel: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createFixture(opts: { yamlExtra?: string } = {}): Promise<Fixture> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wfb-files-'));
  const root = path.join(tmp, 'shares');
  for (const share of ['public', 'eng', 'finance', 'dropbox', 'homes']) {
    await mkdir(path.join(root, share), { recursive: true });
  }
  const yamlPath = path.join(tmp, 'shares.yaml');
  await writeFile(yamlPath, sharesYaml(root, opts.yamlExtra?.replaceAll('HOMES', path.join(root, 'homes'))));
  const apps: FastifyInstance[] = [];

  return {
    tmp,
    root,
    yamlPath,
    async app(user = users.alice, env = {}) {
      const config = testConfig({ SHARES_CONFIG: yamlPath, DATA_DIR: path.join(tmp, 'data'), ...env });
      const app = await createTestApp({ user, config });
      apps.push(app);
      return app;
    },
    async file(rel, content = 'hello') {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return abs;
    },
    async dir(rel) {
      const abs = path.join(root, rel);
      await mkdir(abs, { recursive: true });
      return abs;
    },
    async cleanup() {
      await Promise.all(apps.map((a) => a.close()));
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

export function multipart(
  files: { name: string; content: string | Buffer; field?: string }[],
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----wfbtestboundary' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
    );
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'file'}"; filename="${f.name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
