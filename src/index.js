import { config } from './config.js';
import { logger, errInfo } from './logger.js';
import { createServer } from './server.js';
import { createClient } from './whatsapp.js';

logger.info('starting whatsapp-service');

if (!config.brainSharedSecret) {
  logger.warn('BRAIN_SHARED_SECRET not set — outbound payloads will be unsigned');
}
if (!config.serviceToken) {
  logger.warn('SERVICE_TOKEN not set — inbound API is unprotected');
}

const app = createServer();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'HTTP API listening');
});

const client = createClient();
client.initialize();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  try {
    await client.destroy();
  } catch (err) {
    logger.warn({ err: err.message }, 'error destroying client during shutdown');
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err: errInfo(err) }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err: errInfo(err) }, 'uncaughtException'));
