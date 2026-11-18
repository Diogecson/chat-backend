// Cron de disparos agendados: a cada 30s procura campanhas com
// status='agendado' AND quando_agendar <= NOW() e enfileira as msgs
// pendentes delas no pg-boss.
//
// Sem este cron, uma campanha agendada ficava para sempre em 'agendado'
// e 0/N porque o create-route soh enfileira quando NAO esta agendado.
//
// Tambem faz safety-net: campanhas em_andamento com msgs pendentes que
// nao tem job na fila (ex: perdeu redeploy mid-processamento) sao
// reenfileiradas.

import { query } from '../services/db.js';
import { getBoss, QUEUES } from '../services/queue.js';
import { hasDb } from '../config.js';

const INTERVAL_MS = parseInt(process.env.AGENDADOS_DISPARAR_INTERVAL_MS || '30000', 10);
const LOTE_MAX = parseInt(process.env.AGENDADOS_DISPARAR_LOTE_MAX || '2000', 10);

export function startAgendadosDisparar(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[agendados-disparar] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const boss = await getBoss().catch(() => null);
      if (!boss) {
        // pg-boss nao iniciou — pula tick, tenta de novo
        return;
      }

      // 1) Ativa campanhas agendadas cujo horario chegou: agendado -> em_andamento
      const ativar = await query(
        `UPDATE chat_disparos
         SET status='em_andamento', atualizado_em=NOW()
         WHERE status='agendado'
           AND quando_agendar IS NOT NULL
           AND quando_agendar <= NOW()
         RETURNING codigo, nome, total_msgs`
      ).catch((err) => {
        fastify.log.error('[agendados-disparar] erro ativando: ' + err.message);
        return { rows: [] };
      });

      for (const c of ativar.rows) {
        fastify.log.info(`[agendados-disparar] ativou campanha ${c.codigo} (${c.nome}) — ${c.total_msgs} msgs`);
      }

      // 2) Enfileira as msgs pendentes de TODA campanha em_andamento.
      // Usa singletonKey = msg_id pra evitar duplicacao: se ja ha job
      // ativo pra esse msg_id, pg-boss recusa o send (retorna null).
      // Isso cobre tanto campanhas recem-ativadas (passo 1) quanto
      // campanhas antigas presas sem jobs na fila (ex: perdeu redeploy).
      const pend = await query(
        `SELECT m.id, m.campanha_id
         FROM chat_disparos_msgs m
         JOIN chat_disparos c ON c.codigo = m.campanha_id
         WHERE m.status='pendente'
           AND c.status='em_andamento'
         ORDER BY m.campanha_id, m.id
         LIMIT $1`,
        [LOTE_MAX]
      ).catch(() => ({ rows: [] }));

      let enq = 0, dup = 0;
      for (const r of pend.rows) {
        try {
          const jobId = await boss.send(
            QUEUES.DISPAROS,
            { msg_id: r.id, campanha_id: r.campanha_id },
            { singletonKey: 'msg_' + r.id }
          );
          if (jobId) enq++; else dup++;
        } catch (err) {
          fastify.log.error(`[agendados-disparar] erro send msg ${r.id}: ${err.message}`);
        }
      }
      if (enq || dup) {
        fastify.log.info(`[agendados-disparar] enfileirou ${enq} msgs pendentes${dup ? ` (${dup} ja na fila)` : ''}`);
      }
    } catch (err) {
      fastify.log.error('[agendados-disparar] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  // Primeira execucao 10s apos boot (da tempo do pg-boss subir)
  setTimeout(tick, 10000);
  fastify.log.info(`[agendados-disparar] iniciado, intervalo=${INTERVAL_MS}ms`);
}
