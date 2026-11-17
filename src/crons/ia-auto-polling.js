// IA Auto Polling: monitora chat_mensagens buscando msgs IN de telefones na lista chat_ia_auto.
//
// Como funciona (sem precisar tocar na config da Meta):
// - O n8n antigo continua recebendo as msgs da Meta e gravando em chat_mensagens (mesmo banco)
// - Esse cron, a cada 5s, procura novas msgs IN text cujo telefone esta em chat_ia_auto ativo
// - Pra cada msg nova, chama processarInboundIa que fala com o fluxo n8n da IA Black Friday
//   e devolve a resposta via chat-enviar (Meta API)
//
// Pra nao reprocessar mensagens antigas, mantem checkpoint em chat_ia_auto_polling_state:
//   (chave='last_ts', valor timestamptz)
// A cada tick, busca msgs com timestamp > last_ts, processa e atualiza last_ts.
//
// No boot, se last_ts nao existir, comeca "agora" — ignora backlog.

import { query } from '../services/db.js';
import { hasDb } from '../config.js';
import { processarInboundIa } from '../routes/ia-auto.js';

const INTERVAL_MS = parseInt(process.env.IA_AUTO_POLLING_MS || '5000', 10);

async function ensureState() {
  await query(`
    CREATE TABLE IF NOT EXISTS chat_ia_auto_polling_state (
      chave text PRIMARY KEY,
      valor_ts timestamptz,
      atualizado_em timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    INSERT INTO chat_ia_auto_polling_state (chave, valor_ts)
    VALUES ('last_ts', NOW())
    ON CONFLICT (chave) DO NOTHING
  `);
}

async function getCheckpoint() {
  const r = await query(`SELECT valor_ts FROM chat_ia_auto_polling_state WHERE chave='last_ts' LIMIT 1`);
  return r.rows[0]?.valor_ts || null;
}

async function setCheckpoint(ts) {
  await query(
    `UPDATE chat_ia_auto_polling_state SET valor_ts=$1, atualizado_em=NOW() WHERE chave='last_ts'`,
    [ts]
  );
}

export function startIaAutoPolling(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[ia-auto-polling] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const checkpoint = await getCheckpoint();
      if (!checkpoint) return;

      // Busca msgs IN text novas de telefones na lista ativa
      const res = await query(
        `SELECT m.id, m.conta_id, m.telefone, m.texto, m.timestamp
         FROM chat_mensagens m
         JOIN chat_ia_auto a
           ON a.conta_id = m.conta_id
          AND a.telefone = m.telefone
          AND a.ativo = true
         WHERE m.direcao = 'in'
           AND m.tipo = 'text'
           AND COALESCE(m.texto,'') <> ''
           AND m.timestamp > $1
         ORDER BY m.timestamp ASC
         LIMIT 50`,
        [checkpoint]
      );

      if (!res.rows.length) return;

      let maiorTs = checkpoint;
      for (const m of res.rows) {
        try {
          await processarInboundIa(fastify, {
            conta_id: m.conta_id,
            telefone: m.telefone,
            texto: m.texto,
            tipo: 'text',
          });
        } catch (err) {
          fastify.log.error(`[ia-auto-polling] ${m.conta_id}/${m.telefone}: ${err.message}`);
        }
        // Avanca checkpoint mesmo se erro (pra nao travar na msg quebrada)
        if (new Date(m.timestamp) > new Date(maiorTs)) maiorTs = m.timestamp;
      }
      await setCheckpoint(maiorTs);
      fastify.log.info(`[ia-auto-polling] processou ${res.rows.length} msg(s)`);
    } catch (err) {
      fastify.log.error('[ia-auto-polling] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  ensureState()
    .then(() => {
      setInterval(tick, INTERVAL_MS);
      setTimeout(tick, 10000);
      fastify.log.info(`[ia-auto-polling] iniciado, intervalo=${INTERVAL_MS}ms`);
    })
    .catch(err => fastify.log.error('[ia-auto-polling] ensureState falhou: ' + err.message));
}
