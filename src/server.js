import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, hasDb } from './config.js';
import { closePool } from './services/db.js';
import { stopBoss } from './services/queue.js';
import healthRoutes from './routes/health.js';
import disparosRoutes from './routes/disparos.js';

const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
  },
});

await fastify.register(cors, { origin: true });

// Rotas
await fastify.register(healthRoutes);
await fastify.register(disparosRoutes, { prefix: '/api' });

// Root — ajuda rápida
fastify.get('/', async () => ({
  service: 'chat-backend',
  version: '0.1.0',
  dry_run: config.dryRun,
  has_db: hasDb(),
  endpoints: [
    'GET  /health',
    'GET  /health/db',
    'POST /api/disparos/criar',
    'GET  /api/disparos/list',
  ],
}));

// Graceful shutdown
async function shutdown(signal) {
  fastify.log.info(`${signal} recebido — encerrando...`);
  try {
    await fastify.close();
    await stopBoss();
    await closePool();
    process.exit(0);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  fastify.log.info(`Servidor ouvindo em http://localhost:${config.port}`);
  if (!hasDb()) {
    fastify.log.warn('⚠️  DATABASE_URL vazio — rotas que usam DB vão retornar 503.');
  }
  if (config.dryRun) {
    fastify.log.warn('⚠️  DRY_RUN=true — envios Meta serão simulados, não reais.');
  }
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
