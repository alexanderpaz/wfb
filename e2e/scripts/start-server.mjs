// Seeds the share folders, builds the web app if needed and starts the API
// (which serves the web build) configured against the dev compose stack.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const tmp = resolve(here, '../.tmp');
const port = process.env.E2E_PORT ?? '3000';

rmSync(tmp, { recursive: true, force: true });
const seed = {
  'public/Bienvenida.txt': 'Hola desde la carpeta pública.\n',
  'public/Manuales/guia.md': '# Guía\n',
  'engineering/Proyectos/Alfa/README.md': '# Alfa\n',
  'engineering/Proyectos/Beta/notas.txt': 'notas\n',
  'engineering/diagrama.txt': 'diagrama\n',
  'finance/Presupuesto 2026.csv': 'mes,monto\nenero,100\n',
};
for (const [rel, content] of Object.entries(seed)) {
  const file = join(tmp, 'shares', rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
mkdirSync(join(tmp, 'shares/homes'), { recursive: true });

const sharesYaml = `shares:
  - id: public
    name: Público
    path: ${join(tmp, 'shares/public')}
    visibility: public
    permissions: [read]
  - id: engineering
    name: Ingeniería
    path: ${join(tmp, 'shares/engineering')}
    visibility: private
    acl:
      - group: engineering
        permissions: [read, write, delete]
  - id: finance
    name: Finanzas
    path: ${join(tmp, 'shares/finance')}
    visibility: private
    acl:
      - group: finance
        permissions: [read, write, delete]
home:
  enabled: true
  root: ${join(tmp, 'shares/homes')}
  name: Mi carpeta
  permissions: [read, write, delete]
`;
writeFileSync(join(tmp, 'shares.yaml'), sharesYaml);

const webDist = join(repo, 'apps/web/dist');
if (!existsSync(join(webDist, 'index.html')) || process.env.E2E_BUILD_WEB === '1') {
  const r = spawnSync('pnpm', ['--filter', '@wfb/web', 'build'], { cwd: repo, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: port,
  APP_URL: `http://localhost:${port}`,
  LOG_LEVEL: 'warn',
  SESSION_SECRET: 'e2e-session-secret',
  WEB_DIST: webDist,
  SHARES_CONFIG: join(tmp, 'shares.yaml'),
  DATA_DIR: join(tmp, 'data'),
  LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
  DIRECTORY_KIND: 'ldap',
  LDAP_URL: process.env.E2E_LDAP_URL ?? 'ldap://localhost:1389',
  LDAP_BIND_DN: 'cn=readonly,dc=example,dc=org',
  LDAP_BIND_PASSWORD: 'readonly',
  LDAP_BASE_DN: 'dc=example,dc=org',
  OIDC_ISSUER: process.env.E2E_OIDC_ISSUER ?? 'http://localhost:9000/application/o/wfb/',
  OIDC_CLIENT_ID: 'wfb',
  OIDC_CLIENT_SECRET: 'wfb-dev-secret',
  OIDC_LABEL: 'Authentik',
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? '',
  REDIS_URL: process.env.E2E_REDIS_URL ?? '',
};

const child = spawn('pnpm', ['--filter', '@wfb/api', 'exec', 'tsx', 'src/server.ts'], {
  cwd: repo,
  env,
  stdio: 'inherit',
});
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
