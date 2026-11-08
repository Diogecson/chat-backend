// Worker de disparos: consome a fila "disparos" com concurrency=1
// Para cada job: lê msg_id do banco, chama Meta, atualiza status
import { getBoss, QUEUES, stopBoss } from '../services/queue.js';
import { closePool, getPool } from '../services/db.js';
import { enviarTemplate } from '../services/meta.js';
import { config, hasDb } from '../config.js';

// Função exportada: pode ser chamada tanto standalone (main abaixo)
// quanto embutida no server.js (via boss.work)
export async function processarJobDisparos(job) {
  const { msg_id } = job.data || {};
  if (!msg_id) return { skipped: 'sem msg_id' };

  const pool = getPool();
  const client = await pool.connect();
  try {
    // Marca em_envio ANTES de enviar (atômico)
    const pickRes = await client.query(
      `UPDATE chat_disparos_msgs m
       SET status = 'em_envio',
           tentativas = tentativas + 1,
           enviado_em = NOW()
       FROM chat_disparos c
       WHERE m.id = $1
         AND c.codigo = m.campanha_id
         AND m.status = 'pendente'
         AND c.status IN ('agendado','em_andamento')
       RETURNING
         m.id AS msg_id, m.campanha_id, m.telefone, m.nome, m.extra_vars,
         c.conta_id, c.template_name, c.template_language, c.template_body_vars,
         COALESCE(c.template_body_text,'') AS template_body_text`,
      [msg_id]
    );

    if (!pickRes.rows.length) {
      console.log(`[worker] msg_id=${msg_id} skip (nao pendente)`);
      return { skipped: 'nao_pendente' };
    }

    const row = pickRes.rows[0];

    const contaRes = await client.query(
      `SELECT codigo, nome, tipo, config FROM chat_contas WHERE codigo=$1 AND tipo='meta' LIMIT 1`,
      [row.conta_id]
    );
    if (!contaRes.rows.length) {
      await client.query(
        `UPDATE chat_disparos_msgs SET status='erro', erro_msg=$2 WHERE id=$1`,
        [msg_id, 'conta_nao_encontrada:' + row.conta_id]
      );
      console.error(`[worker] msg_id=${msg_id} ERRO conta_nao_encontrada`);
      return { error: 'conta_nao_encontrada' };
    }

    let accountCfg = {};
    try {
      accountCfg = typeof contaRes.rows[0].config === 'string'
        ? JSON.parse(contaRes.rows[0].config)
        : (contaRes.rows[0].config || {});
    } catch (_) {}
    accountCfg.codigo = contaRes.rows[0].codigo;

    let baseVars = []; try { baseVars = Array.isArray(row.template_body_vars) ? row.template_body_vars : JSON.parse(row.template_body_vars || '[]'); } catch(_){}
    let extras = []; try { extras = Array.isArray(row.extra_vars) ? row.extra_vars : JSON.parse(row.extra_vars || '[]'); } catch(_){}
    const nomeFull = String(row.nome || '').trim();
    const primeiroNome = nomeFull ? nomeFull.split(/\s+/)[0] : 'você';
    const maxLen = Math.max(baseVars.length, extras.length ? extras.length + 1 : 0);
    const bodyVars = [];
    for (let i = 0; i < maxLen; i++) {
      let v = i === 0 ? String(baseVars[0] || '') :
              (extras[i - 1] != null && String(extras[i - 1]).trim() !== '' ? String(extras[i - 1]) : String(baseVars[i] || ''));
      v = v.replace(/\{nome\}/gi, primeiroNome).trim() || primeiroNome;
      bodyVars.push(v);
    }

    const res = await enviarTemplate({
      accountCfg,
      telefone: row.telefone,
      templateName: row.template_name,
      templateLanguage: row.template_language,
      bodyVars,
      campanha_id: row.campanha_id,
    });

    if (res.ok) {
      await client.query(
        `UPDATE chat_disparos_msgs SET status='enviado', external_id=$2, erro_msg='' WHERE id=$1`,
        [msg_id, res.wamid || '']
      );
      console.log(`[worker] msg_id=${msg_id} enviado wamid=${res.wamid}${res.dryRun ? ' (DRY_RUN)' : ''}`);
    } else {
      await client.query(
        `UPDATE chat_disparos_msgs SET status='erro', erro_msg=$2 WHERE id=$1`,
        [msg_id, (res.error || 'erro_desconhecido').substring(0, 250)]
      );
      console.error(`[worker] msg_id=${msg_id} ERRO ${res.error}`);
    }

    return { ok: res.ok, wamid: res.wamid };
  } catch (err) {
    console.error(`[worker] msg_id=${msg_id} EXCEPTION`, err.message);
    try {
      await client.query(
        `UPDATE chat_disparos_msgs SET status='pendente' WHERE id=$1 AND status='em_envio'`,
        [msg_id]
      );
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// Standalone mode: só roda quando chamado como `node src/workers/disparos.worker.js`
// NÃO roda quando o server.js faz `import { processarJobDisparos } from './workers/...'`
const isStandalone = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('disparos.worker.js');

if (isStandalone) {
  const http = await import('node:http');
  const HEALTH_PORT = parseInt(process.env.PORT || '3100');
  const healthServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, role: 'worker-disparos', uptime_s: Math.round(process.uptime()) }));
  });
  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[worker-disparos] health HTTP em :${HEALTH_PORT}`);
  });

  async function main() {
    if (!hasDb()) { console.error('[worker-disparos] DATABASE_URL não configurado'); process.exit(1); }
    const boss = await getBoss();
    if (!boss) { console.error('[worker-disparos] QUEUE_DATABASE_URL não configurado'); process.exit(1); }
    console.log(`[worker-disparos] subiu. DRY_RUN=${config.dryRun}`);
    await boss.work(
      QUEUES.DISPAROS,
      { teamSize: 1, teamConcurrency: 1, newJobCheckInterval: 2000 },
      async (job) => await processarJobDisparos(job)
    );
  }

  async function shutdown(signal) {
    console.log(`[worker-disparos] ${signal} — encerrando...`);
    try {
      healthServer.close();
      await stopBoss();
      await closePool();
      process.exit(0);
    } catch (err) { console.error(err); process.exit(1); }
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  main().catch((err) => { console.error('[worker-disparos] erro fatal', err); process.exit(1); });
}
