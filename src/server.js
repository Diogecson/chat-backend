import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyProxy from '@fastify/http-proxy';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, hasDb } from './config.js';
import { closePool } from './services/db.js';
import { stopBoss, getBoss, QUEUES } from './services/queue.js';
import healthRoutes from './routes/health.js';
import disparosRoutes from './routes/disparos.js';
import authRoutes from './routes/auth.js';
import contasRoutes from './routes/contas.js';
import conversasRoutes from './routes/conversas.js';
import aliasRoutes from './routes/aliases.js';
import acoesRoutes from './routes/acoes.js';
import enviarRoutes from './routes/enviar.js';
import funilRoutes from './routes/funil.js';
import iaRoutes from './routes/ia.js';
import { processarJobDisparos } from './workers/disparos.worker.js';

// URL do n8n (upstream dos webhooks /webhook/*)
const N8N_UPSTREAM = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
  },
  // 25 MB: cobre mídia WhatsApp até 16MB em base64 (~21MB) + headers
  bodyLimit: 25 * 1024 * 1024,
});

// Parser pra text/plain: o login.html (e várias páginas antigas) mandam
// body JSON com Content-Type: text/plain pra fugir de CORS preflight.
// Sem esse parser, req.body fica string crua e p()/req.body[x] vira undefined.
fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => {
  if (!body) return done(null, {});
  try { done(null, JSON.parse(body)); }
  catch (_) { done(null, { _raw: body }); }
});

await fastify.register(cors, { origin: true });

// Rotas API primeiro (prioridade)
await fastify.register(healthRoutes);
await fastify.register(disparosRoutes, { prefix: '/api' });
await fastify.register(authRoutes, { prefix: '/api' });
await fastify.register(contasRoutes, { prefix: '/api' });

// Conversas/Contadores + aliases /webhook/*: TODOS registrados ANTES do proxy
// pra ter prioridade sobre o proxy pro n8n
await fastify.register(conversasRoutes);
await fastify.register(aliasRoutes);
await fastify.register(acoesRoutes);
await fastify.register(enviarRoutes);
await fastify.register(funilRoutes);
await fastify.register(iaRoutes);

// JSON do root — exposto em /api/info pra deixar o / servir o index.html
fastify.get('/api/info', async () => ({
  service: 'chat-backend',
  version: '0.2.0',
  dry_run: config.dryRun,
  has_db: hasDb(),
  conta_fixa: config.contaFixa || null,     // null = modo multi-conta; "meta_XXX" = instância dedicada
  conta_label: config.contaLabel || null,   // ex: "VLC Educacional Curitiba"
  endpoints: [
    'POST /api/auth/login',
    'GET  /health',
    'GET  /health/db',
    'POST /api/disparos/criar',
    'GET  /api/disparos/list',
    'GET  /api/contas',
  ],
}));

// Proxy pra n8n — todos os /webhook/* passam direto pro n8n antigo
// Isso deixa o chat.html original funcionar sem trocar nenhuma URL
await fastify.register(fastifyProxy, {
  upstream: N8N_UPSTREAM,
  prefix: '/webhook',
  rewritePrefix: '/webhook',
  http2: false,
  replyOptions: {
    rewriteRequestHeaders: (req, headers) => ({ ...headers, host: new URL(N8N_UPSTREAM).host }),
  },
});

// Estáticos: serve chat.html, disparos.html, login.html etc da pasta public
// Index: login.html pra quem vai no / direto
await fastify.register(fastifyStatic, {
  root: publicDir,
  prefix: '/',
  index: ['login.html'],
});

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

  // Worker embutido no mesmo processo (evita problemas de health check em serviço separado)
  // Habilita setando WORKER_ENABLED=true
  if (String(process.env.WORKER_ENABLED || 'false').toLowerCase() === 'true' && hasDb()) {
    try {
      const boss = await getBoss();
      if (boss) {
        await boss.work(
          QUEUES.DISPAROS,
          { teamSize: 1, teamConcurrency: 1, newJobCheckInterval: 2000 },
          async (job) => await processarJobDisparos(job)
        );
        fastify.log.info('[worker-embutido] disparos escutando fila pg-boss (concurrency=1)');
      }
    } catch (err) {
      fastify.log.error('[worker-embutido] falha ao iniciar: ' + err.message);
    }
  }
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
