// Cron de disparos: a cada 30s
// 1) Ativa campanhas agendadas cujo horario chegou (agendado -> em_andamento)
// 2) Processa as msgs pendentes DIRETO em-processo (sem pg-boss)
//
// Antes dependia do pg-boss, que estava jogando ERR_INVALID_ARG_TYPE
// neste ambiente. Agora chama o worker direto igual o botao retry.

import { query } from '../services/db.js';
import { hasDb } from '../config.js';
import { processarJobDisparos } from '../workers/disparos.worker.js';

const INTERVAL_MS = parseInt(process.env.AGENDADOS_DISPARAR_INTERVAL_MS || '30000', 10);
// Quantos msgs processar por tick (0.5-2s cada). 100 = ~1-3min por tick.
const LOTE_MAX = parseInt(process.env.AGENDADOS_DISPARAR_LOTE_MAX || '100', 10);

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

      // 2) Resseta msgs em_envio presas (>2min) de volta pra pendente
      await query(
        `UPDATE chat_disparos_msgs SET status='pendente'
         WHERE status='em_envio' AND enviado_em < NOW() - INTERVAL '2 minutes'`
      ).catch(() => {});

      // 3) Pega lote de pendentes e processa DIRETO em-processo (sem pg-boss)
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

      if (!pend.rows.length) return;

      let ok = 0, erro = 0;
      for (const r of pend.rows) {
        try {
          const result = await processarJobDisparos({ data: { msg_id: r.id, campanha_id: r.campanha_id } });
          if (result && result.ok) ok++; else erro++;
        } catch (err) {
          erro++;
          fastify.log.error(`[agendados-disparar] msg ${r.id}: ${err.message}`);
        }
      }
      fastify.log.info(`[agendados-disparar] processou ${ok} ok / ${erro} erro`);
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
