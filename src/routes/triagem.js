// /webhook/chat-triagem-config-* — gestao de triagens (multi-flows)
// Migrado do workflow-triagem-multi.json do n8n.
// Schema: chat_triagem_config + chat_triagem_passos (FK via triagem_codigo).
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

function p(req, name, def = '') {
  const b = req.body || {};
  const v = (b[name] != null && b[name] !== '') ? b[name] : (req.query?.[name] != null && req.query[name] !== '' ? req.query[name] : def);
  return v;
}

export default async function triagemRoutes(fastify) {
  // GET /webhook/chat-triagem-config-list — lista todas com contagem de passos
  const configList = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    try {
      const r = await query(`
        SELECT c.codigo, c.nome, c.ativa, c.ativa_auto, c.contas_ids,
               c.mensagem_inicial, c.mensagem_final, c.max_tentativas, c.atualizado_em,
               (SELECT COUNT(*) FROM chat_triagem_passos p
                WHERE p.triagem_codigo = c.codigo AND COALESCE(p.ativo, true) = true)::int AS total_passos
        FROM chat_triagem_config c
        ORDER BY c.ativa DESC, c.nome ASC
      `);
      return { ok: true, triagens: r.rows, total: r.rows.length };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.get('/webhook/chat-triagem-config-list', configList);
  fastify.post('/webhook/chat-triagem-config-list', configList);

  // POST /webhook/chat-triagem-config-nova
  fastify.post('/webhook/chat-triagem-config-nova', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const nome = String(p(req, 'nome', 'Nova triagem')).trim().substring(0, 80);
    const codigo = 'tri_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    try {
      const r = await query(
        `INSERT INTO chat_triagem_config (codigo, nome, ativa, ativa_auto, mensagem_inicial, mensagem_final, max_tentativas)
         VALUES ($1, $2, false, false,
                 'Olá! Antes de te encaminhar pra um consultor, vou fazer algumas perguntas rápidas.',
                 'Perfeito! Um consultor vai te atender em breve.',
                 2)
         RETURNING codigo, nome`,
        [codigo, nome]
      );
      return { ok: true, codigo: r.rows[0].codigo, nome: r.rows[0].nome };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-config-rename
  fastify.post('/webhook/chat-triagem-config-rename', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const codigo = String(p(req, 'codigo')).trim();
    const nome = String(p(req, 'nome')).trim().substring(0, 80);
    if (!codigo || !nome) return reply.code(400).send({ ok: false, erro: 'codigo e nome obrigatorios' });
    try {
      const r = await query(
        `UPDATE chat_triagem_config SET nome=$2, atualizado_em=NOW() WHERE codigo=$1 RETURNING codigo, nome`,
        [codigo, nome]
      );
      if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'nao encontrada' });
      return { ok: true, codigo: r.rows[0].codigo, nome: r.rows[0].nome };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-config-duplicate
  fastify.post('/webhook/chat-triagem-config-duplicate', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const origem = String(p(req, 'codigo')).trim();
    if (!origem) return reply.code(400).send({ ok: false, erro: 'codigo obrigatorio' });
    const nomeNovo = String(p(req, 'nome_novo', '')).trim().substring(0, 80);
    const codigoNovo = 'tri_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    try {
      // Copia config
      const cfg = await query(`SELECT * FROM chat_triagem_config WHERE codigo=$1`, [origem]);
      if (!cfg.rows.length) return reply.code(404).send({ ok: false, erro: 'origem nao encontrada' });
      const c = cfg.rows[0];
      const nomeFinal = nomeNovo || (c.nome + ' (copia)');
      await query(
        `INSERT INTO chat_triagem_config (codigo, nome, ativa, ativa_auto, contas_ids, mensagem_inicial, mensagem_final, max_tentativas)
         VALUES ($1, $2, false, $3, $4, $5, $6, $7)`,
        [codigoNovo, nomeFinal, c.ativa_auto || false, c.contas_ids || null, c.mensagem_inicial || '', c.mensagem_final || '', c.max_tentativas || 2]
      );
      // Copia passos
      await query(
        `INSERT INTO chat_triagem_passos (codigo, triagem_codigo, ordem, campo, mensagem, tipo_resposta, opcoes, fallback_codigo, ativo)
         SELECT codigo || '_' || substring(md5(random()::text) from 1 for 6), $1, ordem, campo, mensagem, tipo_resposta, opcoes, fallback_codigo, ativo
         FROM chat_triagem_passos
         WHERE triagem_codigo=$2`,
        [codigoNovo, origem]
      );
      return { ok: true, codigo: codigoNovo, nome: nomeFinal };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-config-set-active — so uma pode estar ativa (trigger ja garante)
  fastify.post('/webhook/chat-triagem-config-set-active', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const codigo = String(p(req, 'codigo')).trim();
    if (!codigo) return reply.code(400).send({ ok: false, erro: 'codigo obrigatorio' });
    try {
      // Desativa todas e ativa a escolhida (fallback caso trigger nao exista)
      await query(`UPDATE chat_triagem_config SET ativa=false, atualizado_em=NOW() WHERE ativa=true AND codigo <> $1`, [codigo]);
      const r = await query(
        `UPDATE chat_triagem_config SET ativa=true, atualizado_em=NOW() WHERE codigo=$1 RETURNING codigo, nome, ativa`,
        [codigo]
      );
      if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'nao encontrada' });
      return { ok: true, ...r.rows[0] };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-config-delete
  fastify.post('/webhook/chat-triagem-config-delete', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const codigo = String(p(req, 'codigo')).trim();
    if (!codigo) return reply.code(400).send({ ok: false, erro: 'codigo obrigatorio' });
    if (codigo === 'default') return reply.code(400).send({ ok: false, erro: 'nao pode deletar a triagem default' });
    try {
      await query(`DELETE FROM chat_triagem_passos WHERE triagem_codigo=$1`, [codigo]);
      const r = await query(`DELETE FROM chat_triagem_config WHERE codigo=$1 RETURNING codigo`, [codigo]);
      if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'nao encontrada' });
      return { ok: true, codigo };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });
}
