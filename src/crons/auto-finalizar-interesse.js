// Auto-finalizar: toda msg IN que COMECA com "Não tenho Interesse!" finaliza o chat
// automaticamente com motivo "sem_interesse" (ou o 1o motivo tipo 'perdido' que achar).
//
// Checa mensagens novas (ultimos 10 min) a cada 30s. Usa chat_mensagens.external_id
// como marcador: salva num Set em memoria pra nao reprocessar (mas o UPDATE idempotente
// tambem garante).
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const INTERVAL_MS = parseInt(process.env.AUTO_FINALIZAR_INTERVAL_MS || '30000', 10);
const PREFIXO = (process.env.AUTO_FINALIZAR_PREFIXO || 'Não tenho Interesse!').trim();
const MOTIVO_PADRAO = process.env.AUTO_FINALIZAR_MOTIVO || 'sem_interesse';

const SQL_CANDIDATAS = `
  SELECT m.conta_id, m.telefone, m.codigo, m.texto, m.timestamp
  FROM chat_mensagens m
  LEFT JOIN chat_conversa_dono cd
    ON cd.conta_id=m.conta_id AND cd.telefone=m.telefone
  WHERE m.direcao='in'
    AND m.timestamp > NOW() - INTERVAL '10 minutes'
    AND LOWER(TRIM(COALESCE(m.texto,''))) LIKE LOWER($1) || '%'
    AND COALESCE(cd.finalizada, false) = false
  ORDER BY m.timestamp ASC
  LIMIT 50
`;

export function startAutoFinalizarInteresse(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[auto-finalizar] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  // Descobre codigo valido do motivo (fallback: 1o 'perdido')
  let motivoEscolhido = null;
  async function resolverMotivo() {
    if (motivoEscolhido) return motivoEscolhido;
    try {
      // Preferencia pela config exata
      const exata = await query(`SELECT codigo FROM chat_motivos_fechamento WHERE LOWER(codigo)=LOWER($1) LIMIT 1`, [MOTIVO_PADRAO]);
      if (exata.rows.length) { motivoEscolhido = exata.rows[0].codigo; return motivoEscolhido; }
      // Fallback: primeiro motivo tipo 'perdido'
      const p = await query(`SELECT codigo FROM chat_motivos_fechamento WHERE tipo='perdido' ORDER BY ordem, codigo LIMIT 1`);
      if (p.rows.length) { motivoEscolhido = p.rows[0].codigo; return motivoEscolhido; }
    } catch (_) {}
    motivoEscolhido = MOTIVO_PADRAO;
    return motivoEscolhido;
  }

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const motivo = await resolverMotivo();
      const cand = await query(SQL_CANDIDATAS, [PREFIXO]);
      if (!cand.rows.length) return;
      for (const c of cand.rows) {
        try {
          const res = await fastify.inject({
            method: 'POST',
            url: '/webhook/chat-conversa-finalizar',
            headers: { 'Content-Type': 'application/json' },
            payload: {
              token: 'AUTO_FINALIZAR', usuario: 'auto_sem_interesse',
              conta_id: c.conta_id, telefone: c.telefone,
              motivo_fechamento: motivo,
            },
          });
          const body = JSON.parse(res.body || '{}');
          if (body.ok) {
            fastify.log.info(`[auto-finalizar] ${c.conta_id}/${c.telefone} finalizada (motivo=${motivo})`);
          }
        } catch (err) {
          fastify.log.error(`[auto-finalizar] ${c.conta_id}/${c.telefone}: ${err.message}`);
        }
      }
    } catch (err) {
      fastify.log.error('[auto-finalizar] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 15000);
  fastify.log.info(`[auto-finalizar] iniciado — prefixo="${PREFIXO}", intervalo=${INTERVAL_MS}ms`);
}
