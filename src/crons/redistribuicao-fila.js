// Redistribuicao automatica pra fila:
// Conversas SEM consultor humano, cuja ULTIMA mensagem eh do cliente ha
// mais de N minutos (default 3), sao atribuidas pro proximo da fila (round-robin).
//
// Criterios de "sem consultor":
// - chat_conversa_dono.atendente IS NULL / vazio
// - OU atendente em ('sistema','ia_followup','triagem_ia','admin')
// - OU atendente comeca com 'disparo'
//
// Pula:
// - Conversas finalizadas
// - Clientes com sessao de triagem ATIVA (o engine da triagem toca)
// - Fila desativada (chat_fila_config.ativa=false)
// - Fila vazia (ninguem na fila)

import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const INTERVAL_MS = parseInt(process.env.REDISTRIB_INTERVAL_MS || '60000', 10); // tick 1min
const INATIVIDADE_MIN = parseInt(process.env.REDISTRIB_INATIVIDADE_MIN || '3', 10);

const SQL_CANDIDATAS = `
  WITH ultima AS (
    SELECT DISTINCT ON (conta_id, telefone)
           conta_id, telefone, direcao, timestamp
    FROM chat_mensagens
    WHERE timestamp > NOW() - INTERVAL '24 hours'
    ORDER BY conta_id, telefone, timestamp DESC
  )
  SELECT u.conta_id, u.telefone, u.timestamp AS ultima_ts
  FROM ultima u
  LEFT JOIN chat_conversa_dono cd
    ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
  WHERE u.direcao = 'in'
    AND u.timestamp < NOW() - ($1::int || ' minutes')::interval
    AND COALESCE(cd.finalizada, false) = false
    AND (
      cd.atendente IS NULL
      OR cd.atendente = ''
      OR LOWER(cd.atendente) IN ('sistema','ia_followup','triagem_ia','admin','triagem')
      OR LOWER(cd.atendente) LIKE 'disparo%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM chat_triagem_sessoes s
      WHERE s.conta_id=u.conta_id AND s.telefone=u.telefone
        AND s.status='ativa'
    )
  ORDER BY u.timestamp ASC
  LIMIT 20`;

export function startRedistribuicaoFila(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[redistrib-fila] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      // 1. Checa se fila esta ativa
      const cfg = await query(`SELECT COALESCE(ativa,true) AS ativa FROM chat_fila_config LIMIT 1`).catch(() => ({ rows: [] }));
      const filaAtiva = cfg.rows.length ? cfg.rows[0].ativa !== false : true;
      if (!filaAtiva) return;

      // 2. Busca candidatas
      const cand = await query(SQL_CANDIDATAS, [INATIVIDADE_MIN]);
      if (!cand.rows.length) return;

      // 3. Pra cada, pede proximo da fila e transfere
      for (const c of cand.rows) {
        try {
          const prox = await fastify.inject({
            method: 'POST',
            url: '/webhook/chat-fila-proximo',
            headers: { 'Content-Type': 'application/json' },
            payload: { conta_id: c.conta_id, telefone: c.telefone },
          });
          const body = JSON.parse(prox.body || '{}');
          if (!body.ok || !body.usuario_escolhido) {
            if (body.sem_fila) {
              fastify.log.info('[redistrib-fila] fila vazia ou desativada, pulando');
              return; // nada a fazer
            }
            continue;
          }
          // Transfere via endpoint — ja grava o evento
          await fastify.inject({
            method: 'POST',
            url: '/webhook/chat-conversa-transferir',
            headers: { 'Content-Type': 'application/json' },
            payload: {
              conta_id: c.conta_id,
              telefone: c.telefone,
              novo_dono: body.usuario_escolhido,
              usuario: 'redistribuicao_auto',
            },
          });
          fastify.log.info(`[redistrib-fila] ${c.conta_id}/${c.telefone} -> ${body.usuario_escolhido}`);
        } catch (err) {
          fastify.log.error(`[redistrib-fila] ${c.conta_id}/${c.telefone}: ${err.message}`);
        }
      }
    } catch (err) {
      fastify.log.error('[redistrib-fila] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 20000);
  fastify.log.info(`[redistrib-fila] iniciado, intervalo=${INTERVAL_MS}ms, inatividade=${INATIVIDADE_MIN}min`);
}
