// Follow-up automatico quando cliente para de responder a IA Black Friday.
//
// Fluxo (so pra conversas onde chat_ia_auto.ativo=true):
// 1. Ultima msg eh OUT da ia_blackfriday ha > T1 min → envia FOLLOW_MSG1
//    com atendente='ia_followup_1'
// 2. Ultima msg eh OUT ia_followup_1 ha > T2 min → envia FOLLOW_MSG2
//    com atendente='ia_followup_2'
// 3. Ultima msg eh OUT ia_followup_2 ha > T3 min → finaliza com motivo
//    FOLLOWUP_MOTIVO (default 'sem_interacao')
//
// Se o cliente responder (direcao=in) em qualquer etapa, o estagio reseta
// porque a ultima msg passa a ser dele e a IA Black Friday responde.
//
// Env:
// - FOLLOWUP_ATIVO=true (default true)
// - FOLLOWUP_T1_MIN=5
// - FOLLOWUP_T2_MIN=20
// - FOLLOWUP_T3_MIN=20
// - FOLLOWUP_INTERVAL_MS=60000 (1 min)
// - FOLLOWUP_MSG1='Oi! Ainda está por aí? 👀 Qualquer coisa estou aqui pra te ajudar 😊'
// - FOLLOWUP_MSG2='Se preferir, posso retomar nosso atendimento mais tarde. Me avisa quando quiser 💙'
// - FOLLOWUP_MOTIVO=sem_interacao
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const ATIVO = process.env.FOLLOWUP_ATIVO !== 'false';
const T1_MIN = parseInt(process.env.FOLLOWUP_T1_MIN || '5', 10);
const T2_MIN = parseInt(process.env.FOLLOWUP_T2_MIN || '20', 10);
const T3_MIN = parseInt(process.env.FOLLOWUP_T3_MIN || '20', 10);
const INTERVAL_MS = parseInt(process.env.FOLLOWUP_INTERVAL_MS || '60000', 10);
const MSG1 = process.env.FOLLOWUP_MSG1 || 'Oi! Ainda está por aí? 👀 Qualquer coisa estou aqui pra te ajudar 😊';
const MSG2 = process.env.FOLLOWUP_MSG2 || 'Se preferir, posso retomar nosso atendimento mais tarde. Me avisa quando quiser 💙';
const MOTIVO = process.env.FOLLOWUP_MOTIVO || 'sem_interacao';

// SQL: pega conversas em que a ULTIMA msg eh OUT ia_blackfriday/ia_followup_1/ia_followup_2
// com IA ativa e nao finalizadas, ordenadas pelo timestamp da ultima msg
const SQL_CANDIDATAS = `
  WITH ultimas AS (
    SELECT DISTINCT ON (conta_id, telefone)
      conta_id, telefone, direcao, atendente, timestamp, codigo
    FROM chat_mensagens
    WHERE timestamp > NOW() - INTERVAL '6 hours'
    ORDER BY conta_id, telefone, timestamp DESC
  )
  SELECT u.conta_id, u.telefone, u.atendente, u.timestamp,
         ia.observacao AS ia_obs
  FROM ultimas u
  JOIN chat_ia_auto ia ON ia.conta_id=u.conta_id AND ia.telefone=u.telefone AND ia.ativo=true
  LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
  WHERE u.direcao='out'
    AND LOWER(COALESCE(u.atendente,'')) IN ('ia_blackfriday','ia_followup_1','ia_followup_2')
    AND COALESCE(cd.finalizada, false) = false
  LIMIT 100
`;

export function startFollowupSemResposta(fastify) {
  if (!ATIVO) {
    fastify.log.warn('[followup] desativado por FOLLOWUP_ATIVO=false');
    return;
  }
  if (!hasDb()) {
    fastify.log.warn('[followup] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const r = await query(SQL_CANDIDATAS);
      if (!r.rows.length) return;
      const agora = Date.now();
      for (const c of r.rows) {
        const idade_min = (agora - new Date(c.timestamp).getTime()) / 60000;
        const at = String(c.atendente || '').toLowerCase();
        try {
          if (at === 'ia_blackfriday' && idade_min >= T1_MIN) {
            await enviarFollow(fastify, c, 'ia_followup_1', MSG1);
          } else if (at === 'ia_followup_1' && idade_min >= T2_MIN) {
            await enviarFollow(fastify, c, 'ia_followup_2', MSG2);
          } else if (at === 'ia_followup_2' && idade_min >= T3_MIN) {
            await finalizarPorInacao(fastify, c);
          }
        } catch (err) {
          fastify.log.error(`[followup] ${c.conta_id}/${c.telefone}: ${err.message}`);
        }
      }
    } catch (err) {
      fastify.log.error('[followup] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 20000);
  fastify.log.info(`[followup] iniciado — T1=${T1_MIN}min T2=${T2_MIN}min T3=${T3_MIN}min intervalo=${INTERVAL_MS}ms`);
}

async function enviarFollow(fastify, c, usuario, texto) {
  const res = await fastify.inject({
    method: 'POST',
    url: '/webhook/chat-enviar',
    headers: { 'Content-Type': 'application/json' },
    payload: {
      conta_id: c.conta_id,
      telefone: c.telefone,
      tipo: 'text',
      texto,
      usuario,
    },
  });
  const body = JSON.parse(res.body || '{}');
  if (body.ok) {
    fastify.log.info(`[followup] ${c.conta_id}/${c.telefone} -> ${usuario} ok`);
  } else {
    fastify.log.warn(`[followup] ${c.conta_id}/${c.telefone} -> ${usuario} falhou: ${body.erro || 'sem erro'}`);
  }
}

async function finalizarPorInacao(fastify, c) {
  // Marca IA auto como desligada pra parar polling
  await query(`UPDATE chat_ia_auto SET ativo=false WHERE conta_id=$1 AND telefone=$2`, [c.conta_id, c.telefone]).catch(() => {});
  const res = await fastify.inject({
    method: 'POST',
    url: '/webhook/chat-conversa-finalizar',
    headers: { 'Content-Type': 'application/json' },
    payload: {
      token: 'AUTO_FOLLOWUP',
      usuario: 'auto_followup',
      conta_id: c.conta_id,
      telefone: c.telefone,
      motivo_fechamento: MOTIVO,
    },
  });
  const body = JSON.parse(res.body || '{}');
  if (body.ok) {
    fastify.log.info(`[followup] ${c.conta_id}/${c.telefone} finalizada por inatividade (motivo=${MOTIVO})`);
  } else {
    fastify.log.warn(`[followup] ${c.conta_id}/${c.telefone} finalizar falhou: ${body.erro || 'sem erro'}`);
  }
}
