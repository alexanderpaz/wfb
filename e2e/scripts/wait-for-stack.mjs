// Waits until OpenLDAP and Authentik (OIDC discovery) from deploy/docker-compose.dev.yml are ready.
import { connect } from 'node:net';

const deadline = Date.now() + 5 * 60_000;
const issuer = process.env.E2E_OIDC_ISSUER ?? 'http://localhost:9000/application/o/wfb/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tcp(host, port) {
  return new Promise((resolve) => {
    const s = connect(port, host, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

async function discovery() {
  try {
    const res = await fetch(new URL('.well-known/openid-configuration', issuer));
    return res.ok;
  } catch {
    return false;
  }
}

for (const [name, check] of [
  ['openldap', () => tcp('localhost', 1389)],
  ['authentik', discovery],
]) {
  process.stdout.write(`waiting for ${name}...`);
  while (!(await check())) {
    if (Date.now() > deadline) {
      console.error(`\n${name} not ready in time`);
      process.exit(1);
    }
    await sleep(3000);
  }
  console.log(' ok');
}
