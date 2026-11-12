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

  // GET /webhook/chat-triagem-config — retorna {ok, config, passos}
  // Pega a triagem por codigo (query), ou a ativa, ou 'default'.
  const triagemGet = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const codigoReq = String(p(req, 'codigo', '')).trim();
    try {
      const cfgRes = await query(
        `SELECT codigo, nome, ativa, ativa_auto, ativa_por_palavra_chave, palavras_chave, contas_ids,
                mensagem_inicial, mensagem_final, max_tentativas, atualizado_em
         FROM chat_triagem_config
         WHERE codigo = COALESCE(NULLIF($1, ''), (SELECT codigo FROM chat_triagem_config WHERE ativa=true LIMIT 1), 'default')
         LIMIT 1`,
        [codigoReq]
      );
      const config = cfgRes.rows[0] || {};
      let passos = [];
      if (config.codigo) {
        const passosRes = await query(
          `SELECT codigo, ordem, campo, mensagem, validacao_prompt, ativo, criado_em,
                  COALESCE(tipo_resposta,'text') AS tipo_resposta,
                  COALESCE(opcoes,'[]'::jsonb) AS opcoes,
                  COALESCE(fallback_codigo,'') AS fallback_codigo
           FROM chat_triagem_passos
           WHERE ativo=true AND triagem_codigo = $1
           ORDER BY ordem ASC`,
          [config.codigo]
        );
        passos = passosRes.rows;
      }
      return { ok: true, config, passos };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.get('/webhook/chat-triagem-config', triagemGet);
  fastify.post('/webhook/chat-triagem-config', triagemGet);

  // POST /webhook/chat-triagem-config-save — grava a configuração global da triagem
  fastify.post('/webhook/chat-triagem-config-save', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const codigo = String(b.codigo || 'default').trim();
    const ativa_auto = !!b.ativa_auto;
    const ativa_por_palavra_chave = !!b.ativa_por_palavra_chave;
    const palavras_chave = Array.isArray(b.palavras_chave)
      ? b.palavras_chave.map(x => String(x || '').trim().substring(0, 60)).filter(Boolean).slice(0, 50)
      : [];
    const contas_ids = Array.isArray(b.contas_ids)
      ? b.contas_ids.map(x => String(x || '').trim()).filter(Boolean)
      : [];
    const mensagem_inicial = String(b.mensagem_inicial || '').substring(0, 2000);
    const mensagem_final = String(b.mensagem_final || '').substring(0, 2000);
    const max_tentativas = Math.max(1, Math.min(5, Number(b.max_tentativas || 2)));
    try {
      const r = await query(
        `UPDATE chat_triagem_config
         SET ativa_auto=$2, ativa_por_palavra_chave=$3, palavras_chave=$4, contas_ids=$5,
             mensagem_inicial=$6, mensagem_final=$7, max_tentativas=$8, atualizado_em=NOW()
         WHERE codigo=$1 RETURNING codigo`,
        [codigo, ativa_auto, ativa_por_palavra_chave, palavras_chave, contas_ids,
         mensagem_inicial, mensagem_final, max_tentativas]
      );
      if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'triagem nao encontrada: ' + codigo });
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-passo-save — insert/update de um passo
  fastify.post('/webhook/chat-triagem-passo-save', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const codigo = String(b.codigo || ('passo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6))).trim();
    const triagem_codigo = String(b.triagem_codigo || 'default').trim();
    const ordem = Math.max(1, Math.min(999, Number(b.ordem || 1)));
    const campo = String(b.campo || '').substring(0, 60).trim();
    const mensagem = String(b.mensagem || '').substring(0, 2000).trim();
    const validacao_prompt = String(b.validacao_prompt || '').substring(0, 2000).trim();
    const tipoIn = String(b.tipo_resposta || 'text').trim().toLowerCase();
    const tipo_resposta = ['text', 'buttons', 'list', 'conhecimento'].includes(tipoIn) ? tipoIn : 'text';
    let opcoes = Array.isArray(b.opcoes) ? b.opcoes : [];
    if (typeof b.opcoes === 'string') {
      try { const parsed = JSON.parse(b.opcoes); if (Array.isArray(parsed)) opcoes = parsed; } catch (_) { }
    }
    opcoes = opcoes
      .filter(o => o && (o.titulo || o.id))
      .map(o => ({
        id: String(o.id || '').substring(0, 50).trim(),
        titulo: String(o.titulo || '').substring(0, 50).trim(),
        proximo_codigo: String(o.proximo_codigo || '').substring(0, 80).trim(),
        etiqueta: String(o.etiqueta || '').substring(0, 50).trim(),
      }))
      .slice(0, 10);
    const fallback_codigo = String(b.fallback_codigo || '').substring(0, 80).trim();
    if (!mensagem) return reply.code(400).send({ ok: false, erro: 'mensagem obrigatoria' });
    try {
      const r = await query(
        `INSERT INTO chat_triagem_passos
           (codigo, triagem_codigo, ordem, campo, mensagem, validacao_prompt,
            tipo_resposta, opcoes, fallback_codigo, ativo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,true)
         ON CONFLICT (codigo) DO UPDATE SET
           triagem_codigo=EXCLUDED.triagem_codigo, ordem=EXCLUDED.ordem,
           campo=EXCLUDED.campo, mensagem=EXCLUDED.mensagem,
           validacao_prompt=EXCLUDED.validacao_prompt,
           tipo_resposta=EXCLUDED.tipo_resposta, opcoes=EXCLUDED.opcoes,
           fallback_codigo=EXCLUDED.fallback_codigo, ativo=true, atualizado_em=NOW()
         RETURNING codigo, ordem`,
        [codigo, triagem_codigo, ordem, campo, mensagem, validacao_prompt,
         tipo_resposta, JSON.stringify(opcoes), fallback_codigo]
      );
      if (!r.rows.length) return reply.code(500).send({ ok: false, erro: 'upsert vazio' });
      return { ok: true, codigo: r.rows[0].codigo, ordem: r.rows[0].ordem };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-passo-delete — hard delete
  fastify.post('/webhook/chat-triagem-passo-delete', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const codigo = String(p(req, 'codigo', '')).trim();
    if (!codigo) return reply.code(400).send({ ok: false, erro: 'codigo obrigatorio' });
    try {
      // Limpa base de conhecimento associada tambem (idempotente)
      try { await query(`DELETE FROM chat_triagem_conhecimento WHERE passo_codigo=$1`, [codigo]); } catch (_) { }
      await query(`DELETE FROM chat_triagem_passos WHERE codigo=$1`, [codigo]);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // ==========================================================================
  // BASE DE CONHECIMENTO por passo (tipo_resposta = 'conhecimento')
  // Cada entrada tem um array de chaves e uma resposta. O engine da triagem
  // procura (ILIKE) qualquer uma das chaves na mensagem do cliente e devolve
  // a resposta. Se nenhuma bater, usa o fallback_codigo do passo.
  // ==========================================================================
  async function ensureKbTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_triagem_conhecimento (
        id SERIAL PRIMARY KEY,
        passo_codigo VARCHAR(80) NOT NULL,
        triagem_codigo VARCHAR(80) NOT NULL DEFAULT 'default',
        chaves TEXT[] NOT NULL DEFAULT '{}',
        resposta TEXT NOT NULL,
        ordem INT NOT NULL DEFAULT 0,
        ativo BOOLEAN NOT NULL DEFAULT true,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kb_passo ON chat_triagem_conhecimento (passo_codigo)`);
  }

  // GET /webhook/chat-triagem-conhecimento-list?passo_codigo=XXX
  const kbList = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const passo_codigo = String(p(req, 'passo_codigo', '')).trim();
    if (!passo_codigo) return reply.code(400).send({ ok: false, erro: 'passo_codigo obrigatorio' });
    try {
      await ensureKbTable();
      const r = await query(
        `SELECT id, chaves, resposta, ordem
         FROM chat_triagem_conhecimento
         WHERE passo_codigo=$1 AND ativo=true
         ORDER BY ordem ASC, id ASC`,
        [passo_codigo]
      );
      return { ok: true, entradas: r.rows, total: r.rows.length };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.get('/webhook/chat-triagem-conhecimento-list', kbList);
  fastify.post('/webhook/chat-triagem-conhecimento-list', kbList);

  // POST /webhook/chat-triagem-conhecimento-save — bulk replace: apaga tudo do
  // passo e insere o array novo. Body: {passo_codigo, triagem_codigo, entradas:[{chaves:[], resposta:''}]}
  fastify.post('/webhook/chat-triagem-conhecimento-save', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const passo_codigo = String(b.passo_codigo || '').trim();
    const triagem_codigo = String(b.triagem_codigo || 'default').trim();
    if (!passo_codigo) return reply.code(400).send({ ok: false, erro: 'passo_codigo obrigatorio' });
    let entradas = Array.isArray(b.entradas) ? b.entradas : [];
    entradas = entradas
      .map(e => ({
        chaves: Array.isArray(e.chaves)
          ? e.chaves.map(k => String(k || '').trim().toLowerCase()).filter(Boolean).slice(0, 30)
          : [],
        resposta: String(e.resposta || '').trim().substring(0, 4000),
      }))
      .filter(e => e.chaves.length && e.resposta);
    try {
      await ensureKbTable();
      await query(`DELETE FROM chat_triagem_conhecimento WHERE passo_codigo=$1`, [passo_codigo]);
      for (let i = 0; i < entradas.length; i++) {
        const e = entradas[i];
        await query(
          `INSERT INTO chat_triagem_conhecimento (passo_codigo, triagem_codigo, chaves, resposta, ordem, ativo)
           VALUES ($1,$2,$3::text[],$4,$5,true)`,
          [passo_codigo, triagem_codigo, e.chaves, e.resposta, i + 1]
        );
      }
      return { ok: true, total: entradas.length };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-resetar-conversa — apaga a sessao de triagem
  // de um cliente especifico, pra conversa voltar ao estado "sem triagem"
  // (atendente consegue pegar manualmente). Body: {conta_id, telefone}
  fastify.post('/webhook/chat-triagem-resetar-conversa', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const conta_id = String(p(req, 'conta_id', '')).trim();
    const telefone = String(p(req, 'telefone', '')).trim();
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatorios' });
    try {
      const r = await query(
        `DELETE FROM chat_triagem_sessoes WHERE conta_id=$1 AND telefone=$2 RETURNING conta_id, telefone`,
        [conta_id, telefone]
      );
      return { ok: true, removidas: r.rowCount };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-resetar-sessoes — apaga todas as sessoes ativas
  // (util depois de aplicar um template novo pra ninguem ficar preso na triagem
  // antiga). Body: {conta_id?} opcional pra filtrar por conta.
  fastify.post('/webhook/chat-triagem-resetar-sessoes', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const conta_id = String(p(req, 'conta_id', '')).trim();
    try {
      const sql = conta_id
        ? `DELETE FROM chat_triagem_sessoes WHERE status='ativa' AND conta_id=$1`
        : `DELETE FROM chat_triagem_sessoes WHERE status='ativa'`;
      const args = conta_id ? [conta_id] : [];
      const r = await query(sql, args);
      return { ok: true, removidas: r.rowCount };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-aplicar-template — aplica um fluxo pre-montado
  // na triagem informada. Body: {triagem_codigo, template, limpar:true|false}
  // Templates: 'black_friday_2026'
  fastify.post('/webhook/chat-triagem-aplicar-template', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const triagem_codigo = String(b.triagem_codigo || '').trim();
    const template = String(b.template || '').trim();
    const limpar = b.limpar === true || String(b.limpar) === 'true' || b.limpar === 1;
    const ativar = b.ativar === true || String(b.ativar) === 'true' || b.ativar === 1;
    const resetar_sessoes = b.resetar_sessoes === true || String(b.resetar_sessoes) === 'true' || b.resetar_sessoes === 1;
    if (!triagem_codigo) return reply.code(400).send({ ok: false, erro: 'triagem_codigo obrigatorio' });
    if (!template) return reply.code(400).send({ ok: false, erro: 'template obrigatorio' });

    const templates = {
      black_friday_2026: {
        mensagem_inicial: 'Olá! 👋 Bem-vindo à UniFECAF. Vou fazer algumas perguntas rápidas pra te atender melhor.',
        mensagem_final: 'Perfeito! Um consultor já vai te atender. 🎓',
        passos: [
          {
            codigo: 'bf_1_qualifica', ordem: 1, campo: 'intencao', tipo_resposta: 'buttons',
            mensagem: 'Oi! 👋 Sou da UniFECAF — IGC 4 no MEC. Tô com Black Friday ATÉ 30/11 com mensalidades a partir de R$ 149. Como posso te ajudar?',
            opcoes: [
              { id: 'q_valores', titulo: '💰 Saber valores', proximo_codigo: 'bf_2_valores', etiqueta: 'BF Valores' },
              { id: 'q_matric', titulo: '✅ Quero matricular', proximo_codigo: 'bf_3_curso', etiqueta: 'BF Matricular' },
              { id: 'q_aluno', titulo: '📚 Já sou aluno', proximo_codigo: '__end__', etiqueta: 'Aluno Ativo' },
            ],
          },
          {
            codigo: 'bf_2_valores', ordem: 2, campo: 'duvida', tipo_resposta: 'conhecimento',
            mensagem: 'Legal! Me diz: qual curso te interessa? Ou pode perguntar sobre taxa, prazo, pontualidade, modalidade… 👇',
            fallback_codigo: 'bf_3_curso',
            opcoes: [],
          },
          {
            codigo: 'bf_3_curso', ordem: 3, campo: 'curso_interesse', tipo_resposta: 'text',
            mensagem: 'Pra te ajudar melhor, qual curso você pretende cursar?',
            fallback_codigo: 'bf_4_fechar',
            opcoes: [],
          },
          {
            codigo: 'bf_4_fechar', ordem: 4, campo: 'aceite', tipo_resposta: 'buttons',
            mensagem: 'A Black Friday vai até 30/11/2026. Posso te conectar AGORA com um consultor pra garantir sua vaga?',
            opcoes: [
              { id: 'f_sim', titulo: '🔥 Sim, quero!', proximo_codigo: '__end__', etiqueta: 'LEAD QUENTE BF' },
              { id: 'f_pensar', titulo: '🤔 Vou pensar', proximo_codigo: 'bf_5_despedida', etiqueta: 'LEAD MORNO BF' },
              { id: 'f_nao', titulo: '❌ Não interessa', proximo_codigo: '__end__', etiqueta: 'LEAD FRIO' },
            ],
          },
          {
            codigo: 'bf_5_despedida', ordem: 5, campo: '', tipo_resposta: 'text',
            mensagem: 'Beleza! Pra garantir depois: procure o polo mais próximo ou acesse unifecaf.edu.br. Mas atenção: Black Friday vai só até 30/11/2026. Qualquer dúvida, me chama de novo. 😊',
            fallback_codigo: '__end__',
            opcoes: [],
          },
        ],
        conhecimento: {
          bf_2_valores: [
            { chaves: ['valor', 'preço', 'mensalidade', 'quanto custa', 'quanto é', 'valor curso'], resposta: 'Black Friday: EAD a partir de R$ 149, Semipresencial de R$ 149 a R$ 249 (10% de pontualidade já incluso). Me diz qual curso que eu passo o valor exato.' },
            { chaves: ['valor administração', 'mensalidade administração', 'administração', 'administracao'], resposta: 'Administração EAD: R$ 149/mês. Administração Semipresencial: R$ 199/mês. Valores com 10% de pontualidade.' },
            { chaves: ['ads', 'análise desenvolvimento', 'desenvolvimento sistemas', 'programação', 'programar'], resposta: 'ADS (Análise e Desenvolvimento de Sistemas): R$ 199/mês tanto EAD quanto Semipresencial.' },
            { chaves: ['pedagogia'], resposta: 'Pedagogia Semipresencial: R$ 149/mês.' },
            { chaves: ['psicopedagogia'], resposta: 'Psicopedagogia Bacharelado Semipresencial: R$ 149/mês.' },
            { chaves: ['engenharia', 'engenharias', 'civil', 'elétrica', 'eletrica', 'produção', 'producao'], resposta: 'Engenharias Semipresencial: R$ 249/mês (Civil, Elétrica, Produção, Computação).' },
            { chaves: ['saúde', 'saude', 'biomedicina', 'fisioterapia', 'nutrição', 'nutricao', 'farmácia', 'farmacia', 'radiologia', 'estética', 'estetica', 'educação física', 'educacao fisica', 'terapia ocupacional'], resposta: 'Cursos de Saúde Semipresencial: R$ 249/mês (Biomedicina, Farmácia, Fisioterapia, Nutrição, Radiologia, Estética, Ed. Física, Terapia Ocupacional).' },
            { chaves: ['arquitetura'], resposta: 'Arquitetura Semipresencial: R$ 249/mês.' },
            { chaves: ['tech', 'tecnologia', 'ciência de dados', 'dados', 'ia', 'inteligência artificial', 'inteligencia artificial', 'segurança cibernética', 'seguranca cibernetica', 'nuvem', 'sistema informação', 'sistema informacao'], resposta: 'Cursos Tech EAD: R$ 199/mês (ADS, Ciência de Dados, Computação em Nuvem, IA, Segurança Cibernética, Sistema de Informação, Gestão de TI, Creator/Digital Influencer).' },
            { chaves: ['até quando', 'prazo', 'vigência', 'vigencia', 'deadline', 'última data', 'ultima data'], resposta: 'A Black Friday vai até 30/11/2026, 23h59 (Brasília). Sem prorrogação. A matrícula tem que estar 100% concluída nesse prazo.' },
            { chaves: ['quando começa', 'quando comeca', 'começou', 'comecou', 'início', 'inicio'], resposta: 'A campanha começou em 03/11/2026.' },
            { chaves: ['taxa', 'taxa adesão', 'taxa adesao', 'taxa matrícula', 'taxa matricula', 'quanto é a taxa', 'quanto e a taxa'], resposta: 'Taxa de adesão: mínimo R$ 49,99 e máximo o valor de uma mensalidade. A matrícula só é aceita com o comprovante anexado no UniFECAF Polos.' },
            { chaves: ['pontualidade', 'desconto pontualidade', '10%', 'atrasar', 'atrasei'], resposta: 'Todos os valores já incluem 10% de desconto de pontualidade (vale se pagar até o vencimento). Se atrasar, perde esses 10% daquela parcela + encargos do contrato.' },
            { chaves: ['reajuste', 'aumento', 'sobe', 'aumenta'], resposta: 'O preço promocional vale pelo curso todo. Só há reajuste anual pelo IGP-M (média recente próxima de 5% ao ano), desde que você esteja em dia ao final de cada semestre.' },
            { chaves: ['bolsa', 'convênio', 'convenio', 'outros descontos', 'cumulativo', 'acumular'], resposta: 'Os valores da Black Friday não são cumulativos com bolsas, convênios ou outros descontos da instituição.' },
            { chaves: ['segunda graduação', 'segunda graduacao', 'enem', 'transferência', 'transferencia'], resposta: 'Todas essas formas de ingresso participam: vestibular, ENEM, segunda graduação e transferência.' },
            { chaves: ['presencial'], resposta: 'Cursos presenciais não entram na Black Friday. Seguem a tabela vigente, inclusive taxa de matrícula.' },
            { chaves: ['aluno ativo', 'já estudo', 'ja estudo', 'rematrícula', 'rematricula'], resposta: 'A Black Friday é só para novos alunos. Quem tem matrícula ativa ou rematrícula não participa.' },
            { chaves: ['trancar', 'trancamento', 'cancelar', 'cancelamento', 'reingresso', 'voltar'], resposta: 'Se trancar ou cancelar, o benefício encerra e não volta no reingresso.' },
            { chaves: ['primeira mensalidade', 'começar pagando', 'comecar pagando', 'plano', 'antecipado', 'postecipado'], resposta: 'Vale para plano antecipado e postecipado — a 1ª mensalidade pode vencer no mês de início do curso ou no mês seguinte.' },
            { chaves: ['turma não abrir', 'turma nao abrir', 'turma não abriu', 'devolução', 'devolucao'], resposta: 'Se a turma não fechar o mínimo, você pode trocar por outro curso participante ou pedir a devolução do valor pago.' },
            { chaves: ['vagas', 'vagas limitadas', 'tem vaga'], resposta: 'Vagas limitadas! Garanta o quanto antes no polo mais próximo ou nos canais oficiais.' },
            { chaves: ['novembro', 'dezembro', 'janeiro', 'turma disponível', 'turma disponivel', 'próxima turma', 'proxima turma'], resposta: 'Turmas participantes: Dezembro/26 e Janeiro/27 (a de Novembro/26 fechou em 05/11). Datas variam por polo.' },
            { chaves: ['mec', 'igc', 'qualidade', 'nota mec'], resposta: 'A UniFECAF tem IGC 4 no MEC — uma das únicas instituições com essa nota na avaliação oficial.' },
            { chaves: ['me inscrevi', 'se inscrever e pagar depois'], resposta: 'Não basta se inscrever. A matrícula precisa estar 100% concluída até 30/11/2026: inscrição + aprovação + contrato + taxa paga.' },
            { chaves: ['como matricular', 'como garantir', 'como faço', 'como faco', 'como contratar'], resposta: 'Procure um polo UniFECAF ou os canais oficiais, leve a documentação e pague a taxa de adesão. Depois é só anexar o comprovante no UniFECAF Polos.' },
            { chaves: ['diferença ead semi', 'diferenca ead semi', 'modalidade'], resposta: 'EAD = 100% online. Semipresencial = encontros no polo + aulas online. As duas participam da Black Friday, com valores diferentes.' },
            { chaves: ['documentos', 'documentação', 'documentacao'], resposta: 'Básico: identidade, CPF, comprovante de endereço, histórico escolar e certificado de conclusão. A lista completa você confirma no polo.' },
          ],
        },
      },
    };

    const tpl = templates[template];
    if (!tpl) return reply.code(400).send({ ok: false, erro: 'template desconhecido: ' + template });

    try {
      await ensureKbTable();
      // Verifica se a triagem existe
      const cfg = await query(`SELECT codigo FROM chat_triagem_config WHERE codigo=$1 LIMIT 1`, [triagem_codigo]);
      if (!cfg.rows.length) return reply.code(404).send({ ok: false, erro: 'triagem nao encontrada: ' + triagem_codigo });

      // Limpa passos e conhecimento antigos (opcional)
      if (limpar) {
        const old = await query(`SELECT codigo FROM chat_triagem_passos WHERE triagem_codigo=$1`, [triagem_codigo]);
        for (const row of old.rows) {
          await query(`DELETE FROM chat_triagem_conhecimento WHERE passo_codigo=$1`, [row.codigo]);
        }
        await query(`DELETE FROM chat_triagem_passos WHERE triagem_codigo=$1`, [triagem_codigo]);
      }

      // Atualiza mensagens inicial/final
      await query(
        `UPDATE chat_triagem_config SET mensagem_inicial=$2, mensagem_final=$3, atualizado_em=NOW() WHERE codigo=$1`,
        [triagem_codigo, tpl.mensagem_inicial || '', tpl.mensagem_final || '']
      );

      // Insere passos (com upsert, pra reaplicar template sem duplicar)
      for (const p of tpl.passos) {
        await query(
          `INSERT INTO chat_triagem_passos
             (codigo, triagem_codigo, ordem, campo, mensagem, validacao_prompt,
              tipo_resposta, opcoes, fallback_codigo, ativo)
           VALUES ($1,$2,$3,$4,$5,'',$6,$7::jsonb,$8,true)
           ON CONFLICT (codigo) DO UPDATE SET
             triagem_codigo=EXCLUDED.triagem_codigo, ordem=EXCLUDED.ordem,
             campo=EXCLUDED.campo, mensagem=EXCLUDED.mensagem,
             tipo_resposta=EXCLUDED.tipo_resposta, opcoes=EXCLUDED.opcoes,
             fallback_codigo=EXCLUDED.fallback_codigo, ativo=true, atualizado_em=NOW()`,
          [p.codigo, triagem_codigo, p.ordem, p.campo || '', p.mensagem,
           p.tipo_resposta || 'text', JSON.stringify(p.opcoes || []), p.fallback_codigo || '']
        );
      }

      // Insere base de conhecimento (bulk-replace por passo)
      const kbTotal = { passos: 0, entradas: 0 };
      for (const [passoCodigo, entradas] of Object.entries(tpl.conhecimento || {})) {
        await query(`DELETE FROM chat_triagem_conhecimento WHERE passo_codigo=$1`, [passoCodigo]);
        for (let i = 0; i < entradas.length; i++) {
          const e = entradas[i];
          await query(
            `INSERT INTO chat_triagem_conhecimento (passo_codigo, triagem_codigo, chaves, resposta, ordem, ativo)
             VALUES ($1,$2,$3::text[],$4,$5,true)`,
            [passoCodigo, triagem_codigo, e.chaves, e.resposta, i + 1]
          );
        }
        kbTotal.passos++;
        kbTotal.entradas += entradas.length;
      }

      // Ativa a triagem (vira a usada em producao)
      let ativada = false;
      if (ativar) {
        await query(`UPDATE chat_triagem_config SET ativa=false, atualizado_em=NOW() WHERE ativa=true AND codigo <> $1`, [triagem_codigo]);
        await query(`UPDATE chat_triagem_config SET ativa=true, atualizado_em=NOW() WHERE codigo=$1`, [triagem_codigo]);
        ativada = true;
      }

      // Zera sessoes ativas (clientes travados no fluxo antigo saem da triagem)
      let sessoes_resetadas = 0;
      if (resetar_sessoes) {
        const rs = await query(`DELETE FROM chat_triagem_sessoes WHERE status='ativa'`);
        sessoes_resetadas = rs.rowCount || 0;
      }

      return {
        ok: true,
        template,
        triagem_codigo,
        passos_criados: tpl.passos.length,
        kb_passos: kbTotal.passos,
        kb_entradas: kbTotal.entradas,
        limpou_antigos: limpar,
        ativada,
        sessoes_resetadas,
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // POST /webhook/chat-triagem-conhecimento-match — usado pelo engine em runtime:
  // {passo_codigo, texto} -> {ok, match:true|false, resposta?, entrada_id?}
  fastify.post('/webhook/chat-triagem-conhecimento-match', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const passo_codigo = String(p(req, 'passo_codigo', '')).trim();
    const texto = String(p(req, 'texto', '')).trim().toLowerCase();
    if (!passo_codigo || !texto) return reply.code(400).send({ ok: false, erro: 'passo_codigo e texto obrigatorios' });
    try {
      await ensureKbTable();
      // Busca a entrada com MAIOR número de chaves que casam (unaccent-like simples via lower)
      const r = await query(
        `SELECT id, resposta, chaves,
                (SELECT COUNT(*) FROM unnest(chaves) k WHERE position(lower(k) IN $2) > 0) AS score
         FROM chat_triagem_conhecimento
         WHERE passo_codigo=$1 AND ativo=true
         ORDER BY score DESC, ordem ASC
         LIMIT 1`,
        [passo_codigo, texto]
      );
      const top = r.rows[0];
      if (!top || Number(top.score) === 0) return { ok: true, match: false };
      return { ok: true, match: true, resposta: top.resposta, entrada_id: top.id, score: Number(top.score) };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });
}
