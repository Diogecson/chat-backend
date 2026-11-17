// IA Automatica: telefones em que a IA Black Friday responde sozinha pelo WhatsApp.
// - Lista por telefone (chat_ia_auto)
// - Quando chega msg inbound, inbound.js chama processarInboundIa() que:
//    1. Verifica se telefone esta na lista ativo
//    2. Chama fluxo n8n ia-black-friday-chat com {chatInput, sessionId}
//    3. Recebe resposta, detecta [ENCAMINHAR_CONSULTOR]:
//         SIM: desliga auto + distribui pra fila + envia texto limpo
//         NAO: envia texto normal
//    4. Envia via /webhook/chat-enviar interno
// - Quando consultor HUMANO manda msg, enviar.js chama desligarSeHumano() que desliga auto.

import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const USUARIO_IA = 'ia_blackfriday';
const N8N_UPSTREAM = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';
const IA_WEBHOOK = process.env.IA_BLACKFRIDAY_WEBHOOK || `${N8N_UPSTREAM}/webhook/ia-black-friday-chat`;

export async function ensureTable() {
  if (!hasDb()) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_ia_auto (
        telefone     text NOT NULL,
        conta_id     text NOT NULL,
        ativo        boolean NOT NULL DEFAULT true,
        criado_em    timestamptz NOT NULL DEFAULT NOW(),
        criado_por   text,
        observacao   text,
        ultima_resp  timestamptz,
        PRIMARY KEY (conta_id, telefone)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS chat_ia_auto_log (
        id            BIGSERIAL PRIMARY KEY,
        conta_id      text,
        telefone      text,
        direcao       text, -- 'in' | 'out' | 'encaminhado' | 'erro'
        texto         text,
        duracao_ms    integer,
        criado_em     timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS ix_ia_auto_log_tel ON chat_ia_auto_log(conta_id, telefone, criado_em DESC)`);
    // Tabela de claim (uma linha por msg ja processada) — compartilhada com o cron de polling.
    // Garantida aqui tbm porque chat-ia-auto-add usa pra reivindicar a ultima msg.
    await query(`
      CREATE TABLE IF NOT EXISTS chat_ia_auto_processadas (
        mensagem_id BIGINT PRIMARY KEY,
        processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error('[ia-auto] ensureTable', err.message);
  }
}

// Verifica rapido se tel esta ativo
export async function isAtivo(conta_id, telefone) {
  if (!hasDb()) return false;
  try {
    const r = await query(
      `SELECT ativo FROM chat_ia_auto WHERE conta_id=$1 AND telefone=$2 LIMIT 1`,
      [conta_id, telefone]
    );
    return r.rows.length > 0 && r.rows[0].ativo === true;
  } catch (err) {
    console.error('[ia-auto] isAtivo', err.message);
    return false;
  }
}

// Desliga auto se o usuario que mandou NAO eh a IA (humano ou sistema assumiu)
export async function desligarSeHumano(conta_id, telefone, usuario) {
  if (!hasDb()) return;
  const u = String(usuario || '').toLowerCase();
  if (u === USUARIO_IA || u === 'sistema' || u.startsWith('disparo') || u === 'ia_followup') return;
  try {
    const r = await query(
      `UPDATE chat_ia_auto SET ativo=false WHERE conta_id=$1 AND telefone=$2 AND ativo=true RETURNING telefone`,
      [conta_id, telefone]
    );
    if (r.rows.length) {
      await query(
        `INSERT INTO chat_ia_auto_log (conta_id, telefone, direcao, texto) VALUES ($1,$2,'encaminhado',$3)`,
        [conta_id, telefone, `desligada: humano assumiu (${usuario})`]
      );
      console.log(`[ia-auto] ${conta_id}/${telefone} desligada — humano ${usuario} assumiu`);
    }
  } catch (err) {
    console.error('[ia-auto] desligarSeHumano', err.message);
  }
}

// Chamado pelo inbound depois de inserir a msg no banco
export async function processarInboundIa(fastify, { conta_id, telefone, texto, tipo }) {
  if (!hasDb()) return;
  if (!texto || !telefone) return;
  // So processa text (audio/image exige transcricao — fica pra depois)
  if (tipo && tipo !== 'text') return;
  const ativo = await isAtivo(conta_id, telefone);
  if (!ativo) return;

  const t0 = Date.now();
  let saida = '';
  try {
    // Loga a entrada
    await query(
      `INSERT INTO chat_ia_auto_log (conta_id, telefone, direcao, texto) VALUES ($1,$2,'in',$3)`,
      [conta_id, telefone, texto.substring(0, 2000)]
    );

    // Chama o fluxo n8n
    const sessionId = `${conta_id}__${telefone}`;
    const r = await fetch(IA_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatInput: texto, sessionId, action: 'sendMessage' })
    });
    if (!r.ok) {
      throw new Error(`webhook n8n HTTP ${r.status}`);
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await r.json();
      saida = j.output || j.text || j.message || j.response || '';
    } else {
      saida = await r.text();
    }
    if (!saida || !saida.trim()) throw new Error('resposta vazia da IA');
  } catch (err) {
    console.error('[ia-auto] IA falhou', conta_id, telefone, err.message);
    await query(
      `INSERT INTO chat_ia_auto_log (conta_id, telefone, direcao, texto, duracao_ms) VALUES ($1,$2,'erro',$3,$4)`,
      [conta_id, telefone, err.message, Date.now() - t0]
    );
    return;
  }

  // Detecta encaminhamento
  const tagMatch = saida.match(/\[ENCAMINHAR_CONSULTOR\][\s\S]*$/i);
  let textoLimpo = saida.replace(/\[ENCAMINHAR_CONSULTOR\][\s\S]*$/i, '').trim();
  const encaminhar = !!tagMatch;

  // Envia resposta via chat-enviar interno (tudo que vem sem a tag)
  if (textoLimpo) {
    try {
      await fastify.inject({
        method: 'POST',
        url: '/webhook/chat-enviar',
        headers: { 'Content-Type': 'application/json' },
        payload: {
          conta_id, telefone,
          tipo: 'text',
          texto: textoLimpo,
          usuario: USUARIO_IA,
        }
      });
    } catch (err) {
      console.error('[ia-auto] chat-enviar falhou', err.message);
    }
  }

  await query(
    `UPDATE chat_ia_auto SET ultima_resp=NOW() WHERE conta_id=$1 AND telefone=$2`,
    [conta_id, telefone]
  );
  await query(
    `INSERT INTO chat_ia_auto_log (conta_id, telefone, direcao, texto, duracao_ms) VALUES ($1,$2,'out',$3,$4)`,
    [conta_id, telefone, (textoLimpo || saida).substring(0, 2000), Date.now() - t0]
  );

  // Se pediu encaminhamento: desliga auto + joga pra fila humana
  if (encaminhar) {
    try {
      await query(
        `UPDATE chat_ia_auto SET ativo=false WHERE conta_id=$1 AND telefone=$2`,
        [conta_id, telefone]
      );
      const prox = await fastify.inject({
        method: 'POST',
        url: '/webhook/chat-fila-proximo',
        headers: { 'Content-Type': 'application/json' },
        payload: { conta_id, telefone, excluir_usuario: USUARIO_IA }
      });
      const body = JSON.parse(prox.body || '{}');
      if (body.ok && body.usuario_escolhido) {
        await fastify.inject({
          method: 'POST',
          url: '/webhook/chat-conversa-transferir',
          headers: { 'Content-Type': 'application/json' },
          payload: {
            conta_id, telefone,
            novo_dono: body.usuario_escolhido,
            usuario: USUARIO_IA,
          }
        });
        await query(
          `INSERT INTO chat_ia_auto_log (conta_id, telefone, direcao, texto) VALUES ($1,$2,'encaminhado',$3)`,
          [conta_id, telefone, `encaminhado para ${body.usuario_escolhido} (motivo: tag IA)`]
        );
      } else {
        await query(
          `INSERT INTO chat_ia_auto_log (conta_id, telefone, direcao, texto) VALUES ($1,$2,'encaminhado',$3)`,
          [conta_id, telefone, `encaminhado (sem dono — fila vazia)`]
        );
      }
    } catch (err) {
      console.error('[ia-auto] encaminhar falhou', err.message);
    }
  }
}

export default async function iaAutoRoutes(fastify) {
  await ensureTable();

  // Lista telefones (ativos primeiro)
  fastify.get('/webhook/chat-ia-auto-list', async (req) => {
    if (!hasDb()) return { ok: true, rows: [] };
    const conta_id = String(req.query?.conta_id || '').trim();
    const sql = conta_id
      ? `SELECT a.*, (SELECT nome_contato FROM chat_mensagens m WHERE m.conta_id=a.conta_id AND m.telefone=a.telefone AND m.nome_contato<>'' ORDER BY m.timestamp DESC LIMIT 1) AS nome
         FROM chat_ia_auto a WHERE a.conta_id=$1 ORDER BY a.ativo DESC, a.criado_em DESC LIMIT 500`
      : `SELECT a.*, (SELECT nome_contato FROM chat_mensagens m WHERE m.conta_id=a.conta_id AND m.telefone=a.telefone AND m.nome_contato<>'' ORDER BY m.timestamp DESC LIMIT 1) AS nome
         FROM chat_ia_auto a ORDER BY a.ativo DESC, a.criado_em DESC LIMIT 500`;
    const args = conta_id ? [conta_id] : [];
    try {
      const r = await query(sql, args);
      return { ok: true, rows: r.rows };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Adiciona telefone (liga IA)
  fastify.post('/webhook/chat-ia-auto-add', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem db' });
    const b = req.body || {};
    const conta_id = String(b.conta_id || '').trim();
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    const usuario = String(b.usuario || '').trim();
    const observacao = String(b.observacao || '').substring(0, 500);
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatorios' });
    try {
      await query(
        `INSERT INTO chat_ia_auto (conta_id, telefone, ativo, criado_por, observacao)
         VALUES ($1,$2,true,$3,$4)
         ON CONFLICT (conta_id, telefone) DO UPDATE SET ativo=true, observacao=EXCLUDED.observacao`,
        [conta_id, telefone, usuario, observacao]
      );

      // Dispara imediato se a ULTIMA msg da conversa for do cliente (IN text)
      // e ainda nao tiver resposta posterior. Isso cobre o caso "consultor
      // ativou depois do cliente ja ter mandado msg" — sem isso, o polling
      // so responderia a PROXIMA msg (por causa do checkpoint timestamp).
      let dispararAgora = false;
      try {
        const u = await query(
          `SELECT id, direcao, tipo, texto, timestamp
           FROM chat_mensagens
           WHERE conta_id=$1 AND telefone=$2
           ORDER BY timestamp DESC LIMIT 1`,
          [conta_id, telefone]
        );
        const m = u.rows[0];
        if (m && m.direcao === 'in' && m.tipo === 'text' && String(m.texto||'').trim()) {
          // Reivindica a msg pra evitar o polling tambem pegar
          const claim = await query(
            `INSERT INTO chat_ia_auto_processadas (mensagem_id)
             VALUES ($1) ON CONFLICT (mensagem_id) DO NOTHING RETURNING mensagem_id`,
            [m.id]
          );
          if (claim.rows.length) {
            dispararAgora = true;
            setImmediate(() => {
              processarInboundIa(fastify, {
                conta_id,
                telefone,
                texto: m.texto,
                tipo: 'text',
              }).catch(err => console.error('[ia-auto-add->processar]', err.message));
            });
          }
        }
      } catch (errImed) {
        console.error('[ia-auto-add imediato]', errImed.message);
      }

      return { ok: true, respondeu_agora: dispararAgora };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Desliga ou remove
  fastify.post('/webhook/chat-ia-auto-remove', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem db' });
    const b = req.body || {};
    const conta_id = String(b.conta_id || '').trim();
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    const hard = b.hard === true;
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatorios' });
    try {
      if (hard) {
        await query(`DELETE FROM chat_ia_auto WHERE conta_id=$1 AND telefone=$2`, [conta_id, telefone]);
      } else {
        await query(`UPDATE chat_ia_auto SET ativo=false WHERE conta_id=$1 AND telefone=$2`, [conta_id, telefone]);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Log por telefone (debug)
  fastify.get('/webhook/chat-ia-auto-log', async (req) => {
    if (!hasDb()) return { ok: true, rows: [] };
    const conta_id = String(req.query?.conta_id || '').trim();
    const telefone = String(req.query?.telefone || '').replace(/\D/g, '');
    if (!conta_id || !telefone) return { ok: false, erro: 'conta_id e telefone obrigatorios' };
    try {
      const r = await query(
        `SELECT direcao, texto, duracao_ms, criado_em FROM chat_ia_auto_log
         WHERE conta_id=$1 AND telefone=$2 ORDER BY criado_em DESC LIMIT 100`,
        [conta_id, telefone]
      );
      return { ok: true, rows: r.rows };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Limpar historico de log (so dessa conta/telefone)
  fastify.post('/webhook/chat-ia-auto-log-limpar', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem db' });
    const b = req.body || {};
    const conta_id = String(b.conta_id || '').trim();
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatorios' });
    try {
      const r = await query(
        `DELETE FROM chat_ia_auto_log WHERE conta_id=$1 AND telefone=$2`,
        [conta_id, telefone]
      );
      return { ok: true, apagados: r.rowCount || 0 };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Liga/desliga a IA como "atendente virtual" na fila de distribuicao.
  // Garante que o usuario ia_blackfriday existe em chat_atendentes.
  // Quando na_fila=true, o chat-fila-proximo pode escolher ela como
  // qualquer outro consultor; quando ela "ganha" uma transferencia, o
  // chat-conversa-transferir ativa automaticamente o chat_ia_auto pro
  // telefone (hook em acoes.js).
  fastify.post('/webhook/chat-ia-fila-toggle', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem db' });
    const b = req.body || {};
    const na_fila = !!(b.na_fila === true || b.na_fila === 'true' || b.na_fila === 1);
    const pos = !!(b.fila_apos_expediente === true || b.fila_apos_expediente === 'true' || b.fila_apos_expediente === 1);
    try {
      await query(`ALTER TABLE chat_atendentes ADD COLUMN IF NOT EXISTS fila_apos_expediente BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
      // UPSERT do atendente IA. 'senha' eh NOT NULL na tabela — a IA nao
      // loga, entao passo uma string impossivel de match (nao eh hash
      // valido de nenhuma funcao de login). Se existir mais coluna NOT
      // NULL que eu nao sei, o ON CONFLICT nunca vai cair no INSERT
      // original depois do primeiro sucesso.
      await query(
        `INSERT INTO chat_atendentes (usuario, nome, senha, papel, ativo, foto_url, contas_permitidas, na_fila, fila_apos_expediente)
         VALUES ($1, $2, '!ia_nao_loga!', 'USER', true, '', ARRAY['*']::text[], $3, $4)
         ON CONFLICT (usuario) DO UPDATE SET
           nome = EXCLUDED.nome,
           papel = 'USER',
           ativo = true,
           na_fila = EXCLUDED.na_fila,
           fila_apos_expediente = EXCLUDED.fila_apos_expediente`,
        [USUARIO_IA, '🤖 IA Black Friday', na_fila, pos]
      );
      return { ok: true, usuario: USUARIO_IA, na_fila, fila_apos_expediente: pos };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Status rapido (pra UI)
  fastify.get('/webhook/chat-ia-fila-status', async () => {
    if (!hasDb()) return { ok: false };
    try {
      const r = await query(
        `SELECT COALESCE(na_fila,false) AS na_fila,
                COALESCE(fila_apos_expediente,false) AS fila_apos_expediente,
                COALESCE(ativo,false) AS ativo
         FROM chat_atendentes WHERE usuario=$1 LIMIT 1`,
        [USUARIO_IA]
      );
      const row = r.rows[0] || { na_fila: false, fila_apos_expediente: false, ativo: false, cadastrada: false };
      return { ok: true, usuario: USUARIO_IA, cadastrada: !!r.rows[0], ...row };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // Teste manual: simula receber uma msg
  fastify.post('/webhook/chat-ia-auto-teste', async (req, reply) => {
    const b = req.body || {};
    const conta_id = String(b.conta_id || '').trim();
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    const texto = String(b.texto || '').trim();
    if (!conta_id || !telefone || !texto) return reply.code(400).send({ ok: false, erro: 'conta_id, telefone e texto obrigatorios' });
    await processarInboundIa(fastify, { conta_id, telefone, texto, tipo: 'text' });
    return { ok: true };
  });
}
