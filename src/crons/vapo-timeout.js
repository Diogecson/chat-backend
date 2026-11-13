// VAPO: leads que passaram X minutos SEM primeira resposta do consultor e
// foram realocados automaticamente pra outro.
//
// Regra:
// - Conversa com dono HUMANO (nao sistema/bots), nao finalizada
// - Atribuida ha >= VAPO_TIMEOUT_MIN (default 10)
// - NENHUMA msg 'out' de um atendente humano depois do atribuido_em
//   (ignora: sistema, ia_followup, triagem_ia, admin, redistribuicao_auto,
//    disparo:*, encerramento_auto e qualquer *_auto)
// - Transfere pro proximo da fila que ainda nao foi tentado nas ultimas 24h
// - Se TODOS ja tentaram, manda pro usuario fallback (VAPO_FALLBACK_USUARIO)
//   mesmo que esteja offline/fora da fila
// - Grava em chat_vapo_log pra exibir no menu "VAPO"
//
// Difere do redistribuicao-fila: aquele olha "ultima msg do cliente ha 3min
// com ninguem atendendo"; este olha "atribuido ha 10min e consultor nao
// respondeu a PRIMEIRA mensagem do cliente".

import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const INTERVAL_MS = parseInt(process.env.VAPO_INTERVAL_MS || '60000', 10); // tick 1min
const TIMEOUT_MIN = parseInt(process.env.VAPO_TIMEOUT_MIN || '10', 10);
const FALLBACK = (process.env.VAPO_FALLBACK_USUARIO || 'soares fecaf').toLowerCase();
const JANELA_TENTATIVAS_H = parseInt(process.env.VAPO_JANELA_TENTATIVAS_H || '24', 10);

// Usuarios que NAO contam como "resposta humana" (bots e automatismos)
const USUARIOS_IGNORAR = [
  'sistema', 'ia_followup', 'triagem_ia', 'triagem', 'admin',
  'redistribuicao_auto', 'sistema_encerramento', 'encerramento_auto',
  'vapo_auto', 'auto_finalizar',
];

async function ensureVapoLogTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS chat_vapo_log (
      id BIGSERIAL PRIMARY KEY,
      conta_id VARCHAR(80) NOT NULL,
      telefone VARCHAR(40) NOT NULL,
      nome_contato VARCHAR(200) DEFAULT '',
      dono_antigo VARCHAR(80) DEFAULT '',
      dono_novo VARCHAR(80) DEFAULT '',
      minutos_sem_resposta INT DEFAULT 0,
      motivo VARCHAR(40) DEFAULT 'timeout_primeira',
      fallback BOOLEAN DEFAULT false,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vapo_log_telefone ON chat_vapo_log(telefone, criado_em DESC)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_vapo_log_criado ON chat_vapo_log(criado_em DESC)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_vapo_log_dono_antigo ON chat_vapo_log(LOWER(dono_antigo), criado_em DESC)`).catch(() => {});
}

// Busca conversas atribuidas ha >= TIMEOUT_MIN sem resposta humana do dono atual
// Retorna: conta_id, telefone, dono atual, atribuido_em, minutos
const SQL_CANDIDATAS = `
  SELECT cd.conta_id,
         cd.telefone,
         LOWER(cd.atendente) AS dono_atual,
         cd.atribuido_em,
         EXTRACT(EPOCH FROM (NOW() - cd.atribuido_em))/60 AS minutos
  FROM chat_conversa_dono cd
  WHERE COALESCE(cd.finalizada, false) = false
    AND cd.atendente IS NOT NULL
    AND cd.atendente <> ''
    AND LOWER(cd.atendente) NOT IN ('sistema','ia_followup','triagem_ia','triagem','admin','vapo_auto','redistribuicao_auto','sistema_encerramento','encerramento_auto')
    AND LOWER(cd.atendente) NOT LIKE 'disparo%'
    AND cd.atribuido_em < NOW() - ($1::int || ' minutes')::interval
    AND NOT EXISTS (
      SELECT 1 FROM chat_mensagens m
      WHERE m.conta_id = cd.conta_id
        AND m.telefone = cd.telefone
        AND m.direcao = 'out'
        AND m.timestamp >= cd.atribuido_em
        AND LOWER(COALESCE(m.atendente,'')) NOT IN (
          'sistema','ia_followup','triagem_ia','triagem','admin',
          'redistribuicao_auto','sistema_encerramento','encerramento_auto',
          'vapo_auto','auto_finalizar',''
        )
        AND LOWER(COALESCE(m.atendente,'')) NOT LIKE 'disparo%'
        AND LOWER(COALESCE(m.atendente,'')) NOT LIKE '%_auto'
    )
    AND EXISTS (
      SELECT 1 FROM chat_mensagens mi
      WHERE mi.conta_id = cd.conta_id
        AND mi.telefone = cd.telefone
        AND mi.direcao = 'in'
        AND mi.timestamp >= cd.atribuido_em
    )
  ORDER BY cd.atribuido_em ASC
  LIMIT 30
`;

export function startVapoTimeout(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[vapo] sem DB — nao iniciado');
    return;
  }
  let rodando = false;
  let tabelaOk = false;

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      if (!tabelaOk) { await ensureVapoLogTable(); tabelaOk = true; }

      // Checa se fila esta ativa — se nao, so segue adiante quem precisar do fallback
      const cfg = await query(`SELECT COALESCE(ativa,true) AS ativa FROM chat_fila_config LIMIT 1`).catch(() => ({ rows: [] }));
      const filaAtiva = cfg.rows.length ? cfg.rows[0].ativa !== false : true;

      const cand = await query(SQL_CANDIDATAS, [TIMEOUT_MIN]);
      if (!cand.rows.length) return;

      for (const c of cand.rows) {
        try {
          // Quem ja foi tentado nesse telefone nas ultimas 24h (inclui dono_antigo
          // e dono_novo) + o dono atual (pra nao mandar pra ele de novo)
          const tent = await query(
            `SELECT LOWER(dono_antigo) AS u FROM chat_vapo_log
             WHERE telefone=$1 AND criado_em > NOW() - ($2::int || ' hours')::interval
             UNION
             SELECT LOWER(dono_novo) FROM chat_vapo_log
             WHERE telefone=$1 AND criado_em > NOW() - ($2::int || ' hours')::interval`,
            [c.telefone, JANELA_TENTATIVAS_H]
          );
          const tentados = new Set(tent.rows.map(r => r.u).filter(Boolean));
          tentados.add(c.dono_atual);
          tentados.add(FALLBACK); // fallback nunca entra na fila normal

          // Busca proximo da fila que NAO esteja em tentados
          let escolhido = null;
          let fallbackUsado = false;
          if (filaAtiva) {
            const expedienteOk = await query(
              `SELECT ativa FROM chat_fila_config LIMIT 1`
            ).catch(() => ({ rows: [{ ativa: true }] }));
            if (expedienteOk.rows[0]?.ativa !== false) {
              const q = await query(
                `SELECT LOWER(a.usuario) AS usuario,
                        COALESCE(cnt.backlog,0)::int AS backlog,
                        cnt.ultima_em
                 FROM chat_atendentes a
                 LEFT JOIN LATERAL (
                   SELECT COUNT(*)::int AS backlog, MAX(atribuido_em) AS ultima_em
                   FROM chat_conversa_dono cd
                   WHERE LOWER(cd.atendente) = LOWER(a.usuario)
                     AND COALESCE(cd.finalizada,false)=false
                 ) cnt ON true
                 WHERE COALESCE(a.ativo,true)=true
                   AND COALESCE(a.na_fila,false)=true
                   AND LOWER(COALESCE(a.papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
                   AND LOWER(a.usuario) <> 'admin'
                 ORDER BY backlog ASC, ultima_em ASC NULLS FIRST, a.usuario ASC`
              );
              escolhido = (q.rows || []).find(r => !tentados.has(r.usuario))?.usuario || null;
            }
          }
          if (!escolhido) {
            escolhido = FALLBACK;
            fallbackUsado = true;
          }

          // Nome do contato (opcional, pra exibir na tabela VAPO)
          let nomeContato = '';
          try {
            const nm = await query(
              `SELECT COALESCE(nome_contato,'') AS n FROM chat_mensagens
               WHERE conta_id=$1 AND telefone=$2 AND nome_contato IS NOT NULL AND nome_contato<>''
               ORDER BY timestamp DESC LIMIT 1`,
              [c.conta_id, c.telefone]
            );
            nomeContato = nm.rows[0]?.n || '';
          } catch (_) {}

          // Grava log ANTES da transferencia, pra proxima iteracao ja ver
          await query(
            `INSERT INTO chat_vapo_log
              (conta_id, telefone, nome_contato, dono_antigo, dono_novo,
               minutos_sem_resposta, motivo, fallback)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [c.conta_id, c.telefone, nomeContato, c.dono_atual, escolhido,
             Math.round(c.minutos), fallbackUsado ? 'timeout_fallback' : 'timeout_primeira',
             fallbackUsado]
          );

          // Transfere via endpoint (grava evento no historico do chat)
          await fastify.inject({
            method: 'POST',
            url: '/webhook/chat-conversa-transferir',
            headers: { 'Content-Type': 'application/json' },
            payload: {
              conta_id: c.conta_id,
              telefone: c.telefone,
              novo_dono: escolhido,
              usuario: 'vapo_auto',
            },
          });

          fastify.log.info(`[vapo] ${c.conta_id}/${c.telefone} ${c.dono_atual} -> ${escolhido}${fallbackUsado ? ' (FALLBACK)' : ''} (${Math.round(c.minutos)}min)`);
        } catch (err) {
          fastify.log.error(`[vapo] ${c.conta_id}/${c.telefone}: ${err.message}`);
        }
      }
    } catch (err) {
      fastify.log.error('[vapo] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 30000);
  fastify.log.info(`[vapo] iniciado, intervalo=${INTERVAL_MS}ms, timeout=${TIMEOUT_MIN}min, fallback=${FALLBACK}`);
}
