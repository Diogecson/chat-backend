// Cron de contadores: atualiza chat_disparos.enviadas/falharam + marca 'concluido'
// E recupera msgs presas em 'em_envio' por mais de 10 min
import http from 'node:http';
import { query, closePool } from '../services/db.js';
import { hasDb } from '../config.js';

// Mini HTTP server pro EasyPanel não matar (igual ao worker)
const HEALTH_PORT = parseInt(process.env.PORT || '3100');
const healthServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, role: 'cron-contadores', uptime_s: Math.round(process.uptime()) }));
});
healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[cron-contadores] health HTTP em :${HEALTH_PORT}`);
});

const INTERVAL_MS = 2 * 60 * 1000; // 2 min

async function tick() {
  if (!hasDb()) {
    console.warn('[cron-contadores] sem DB — pulando');
    return;
  }
  try {
    const r1 = await query(`
      WITH stats AS (
        SELECT campanha_id,
               COUNT(*) FILTER (WHERE status='enviado') AS enviadas,
               COUNT(*) FILTER (WHERE status IN ('erro','cancelado')) AS falharam
        FROM chat_disparos_msgs
        WHERE campanha_id IN (SELECT codigo FROM chat_disparos WHERE status='em_andamento')
        GROUP BY campanha_id
      )
      UPDATE chat_disparos c
      SET enviadas = COALESCE(s.enviadas, 0),
          falharam = COALESCE(s.falharam, 0),
          atualizado_em = NOW(),
          status = CASE
            WHEN COALESCE(s.enviadas, 0) + COALESCE(s.falharam, 0) >= c.total_msgs THEN 'concluido'
            ELSE 'em_andamento'
          END
      FROM stats s
      WHERE c.codigo = s.campanha_id
        AND c.status = 'em_andamento';
    `);
    const r2 = await query(`
      UPDATE chat_disparos_msgs
      SET status = 'pendente'
      WHERE status = 'em_envio'
        AND enviado_em < NOW() - INTERVAL '10 minutes';
    `);
    if (r1.rowCount || r2.rowCount) {
      console.log(`[cron-contadores] camps atualizadas=${r1.rowCount || 0}  em_envio→pendente=${r2.rowCount || 0}`);
    }
  } catch (err) {
    console.error('[cron-contadores] erro', err.message);
  }
}

async function shutdown(signal) {
  console.log(`[cron-contadores] ${signal} — encerrando...`);
  healthServer.close();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[cron-contadores] subiu. intervalo=${INTERVAL_MS / 1000}s`);
tick();
setInterval(tick, INTERVAL_MS);
