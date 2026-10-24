import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({ config });

let shuttingDown = false;

// app.close() stops accepting connections, waits for in-flight requests and
// runs the onClose hooks (Redis, Prisma, background sweepers).
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    app.log.warn({ signal }, 'second signal received, exiting now');
    process.exit(1);
  }
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    app.log.error({ timeoutMs: config.shutdownTimeoutMs }, 'graceful shutdown timed out');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();
  try {
    await app.close();
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ appUrl: config.appUrl, oidcRedirectUri: config.oidc?.redirectUri }, 'wfb api ready');
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  await app.close().catch(() => undefined);
  process.exit(1);
}
