// IA Auto Polling: monitora chat_mensagens buscando msgs IN de telefones na lista chat_ia_auto.
//
// Como funciona (sem precisar tocar na config da Meta):
// - O n8n antigo continua recebendo as msgs da Meta e gravando em chat_mensagens (mesmo banco)
// - Esse cron, a cada 5s, procura novas msgs IN text cujo telefone esta em chat_ia_auto ativo
// - Pra cada msg nova, chama processarInboundIa que fala com o fluxo n8n da IA Black Friday
//   e devolve a resposta via chat-enviar (Meta API)
//
// Protecao contra DUPLICACAO (multiplas replicas, restart, race):
// - Tabela chat_ia_auto_processadas (mensagem_id BIGINT PK) registra cada id ja processado
// - Antes de chamar a IA, tentamos INSERT ON CONFLICT DO NOTHING:
//   se retornar linha, essa instancia "claimou" a msg e processa
//   se nao retornar, outra instancia ja pegou, pula
// - Checkpoint (last_ts) ainda e usado pra limitar a janela de busca (performance)

import { query } from '../services/db.js';
import { hasDb } from '../config.js';
import { processarInboundIa } from '../routes/ia-auto.js';
import { ehLinkSocialIsolado } from './auto-finalizar-link-social.js';

const INTERVAL_MS = parseInt(process.env.IA_AUTO_POLLING_MS || '5000', 10);

async function ensureState() {
  // Tabela de checkpoint (janela de busca)
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS chat_ia_auto_polling_state (
          chave text PRIMARY KEY,
          valor_ts timestamptz,
          atualizado_em timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      break;
    } catch (err) {
      const msg = String(err.message || '');
      const corrida = msg.includes('pg_type_typname_nsp_index')
                   || msg.includes('duplicate key')
                   || msg.includes('already exists');
      if (!corrida) throw err;
      await new Promise(r => setTimeout(r, 500));
      const existe = await query(`SELECT to_regclass('public.chat_ia_auto_polling_state') AS t`);
      if (existe.rows[0]?.t) break;
    }
  }
  await query(`
    INSERT INTO chat_ia_auto_polling_state (chave, valor_ts)
    VALUES ('last_ts', NOW())
    ON CONFLICT (chave) DO NOTHING
  `);

  // Tabela de claim (uma linha por msg ja processada)
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS chat_ia_auto_processadas (
          mensagem_id BIGINT PRIMARY KEY,
          processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      break;
    } catch (err) {
      const msg = String(err.message || '');
      const corrida = msg.includes('pg_type_typname_nsp_index')
                   || msg.includes('duplicate key')
                   || msg.includes('already exists');
      if (!corrida) throw err;
      await new Promise(r => setTimeout(r, 500));
      const existe = await query(`SELECT to_regclass('public.chat_ia_auto_processadas') AS t`);
      if (existe.rows[0]?.t) break;
    }
  }
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

// Tenta claim atomico: retorna true se essa instancia ganhou o direito de processar essa msg
async function claimMsg(mensagem_id) {
  const r = await query(
    `INSERT INTO chat_ia_auto_processadas (mensagem_id)
     VALUES ($1)
     ON CONFLICT (mensagem_id) DO NOTHING
     RETURNING mensagem_id`,
    [mensagem_id]
  );
  return r.rows.length > 0;
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

      // Busca msgs IN text OU audio novas de telefones na lista ativa
      // LEFT JOIN em processadas filtra o que ja foi claimado por outra instancia
      // Pra audio, exige midia_url preenchida (senao nao da pra transcrever)
      const res = await query(
        `SELECT m.id, m.codigo, m.conta_id, m.telefone, m.tipo, m.texto, m.midia_url, m.timestamp
         FROM chat_mensagens m
         JOIN chat_ia_auto a
           ON a.conta_id = m.conta_id
          AND a.telefone = m.telefone
          AND a.ativo = true
         LEFT JOIN chat_ia_auto_processadas p
           ON p.mensagem_id = m.id
         WHERE m.direcao = 'in'
           AND (
             (m.tipo = 'text' AND COALESCE(m.texto,'') <> '')
             OR (m.tipo = 'audio' AND COALESCE(m.midia_url,'') LIKE 'data:%')
           )
           AND m.timestamp > $1
           AND p.mensagem_id IS NULL
         ORDER BY m.timestamp ASC
         LIMIT 50`,
        [checkpoint]
      );

      if (!res.rows.length) return;

      let maiorTs = checkpoint;
      let processadas = 0;
      let puladas = 0;
      for (const m of res.rows) {
        // Avanca checkpoint mesmo se pularmos (pra nao travar na msg)
        if (new Date(m.timestamp) > new Date(maiorTs)) maiorTs = m.timestamp;

        // Claim atomico — se outra instancia (ou tick anterior) ja pegou, pula
        let ganhou = false;
        try {
          ganhou = await claimMsg(m.id);
        } catch (err) {
          fastify.log.error(`[ia-auto-polling] claim ${m.id}: ${err.message}`);
          continue;
        }
        if (!ganhou) {
          puladas++;
          continue;
        }

        // Bloqueia: msg que eh so link de share social (facebook.com/share, fb.me, etc)
        // O cron auto-finalizar-link-social cuida da finalizacao em 30s.
        if (m.tipo === 'text' && ehLinkSocialIsolado(m.texto)) {
          fastify.log.info(`[ia-auto-polling] ${m.conta_id}/${m.telefone} msg eh link social isolado — nao chama IA`);
          continue;
        }

        try {
          if (m.tipo === 'audio') {
            // Extrai base64 e mime da data URL (ex: data:audio/ogg;base64,AAAA...)
            const mt = String(m.midia_url || '').match(/^data:([^;]+);base64,(.*)$/);
            if (!mt) {
              fastify.log.warn(`[ia-auto-polling] audio msg ${m.id} midia_url nao e data: — pulando`);
              puladas++;
              continue;
            }
            const mime_type = mt[1] || 'audio/ogg';
            const audio_base64 = mt[2] || '';
            if (!audio_base64) {
              fastify.log.warn(`[ia-auto-polling] audio msg ${m.id} sem base64 — pulando`);
              puladas++;
              continue;
            }
            fastify.log.info(`[ia-auto-polling] audio ${m.conta_id}/${m.telefone} (${audio_base64.length} chars base64)`);
            await processarInboundIa(fastify, {
              conta_id: m.conta_id,
              telefone: m.telefone,
              texto: '',
              tipo: 'audio',
              audio_base64,
              mime_type,
              media_codigo: m.codigo,
            });
          } else {
            await processarInboundIa(fastify, {
              conta_id: m.conta_id,
              telefone: m.telefone,
              texto: m.texto,
              tipo: 'text',
            });
          }
          processadas++;
        } catch (err) {
          fastify.log.error(`[ia-auto-polling] ${m.conta_id}/${m.telefone}: ${err.message}`);
        }
      }
      await setCheckpoint(maiorTs);
      if (processadas || puladas) {
        fastify.log.info(`[ia-auto-polling] processou ${processadas} msg(s), pulou ${puladas} (ja processadas)`);
      }
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
