// Aliases de AÇÕES (write): finalizar, transferir, delete, etiqueta, retorno, etc
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

function p(req, name, def = '') {
  const v = (req.body && req.body[name]) ?? req.query?.[name];
  if (v == null || v === '') return def;
  return String(v);
}
async function withDb(reply, fn) {
  if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
  try { return await fn(); } catch (err) { reply.code(500); return { ok: false, erro: err.message }; }
}

export default async function acoesRoutes(fastify) {
  // === tabela chat_config_global (singleton key-value) ===
  async function ensureConfigGlobal() {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_config_global (
        chave VARCHAR(80) PRIMARY KEY,
        valor TEXT NOT NULL DEFAULT '',
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  async function getConfigValue(chave, def = '') {
    try {
      await ensureConfigGlobal();
      const r = await query(`SELECT valor FROM chat_config_global WHERE chave=$1`, [chave]);
      return r.rows[0]?.valor ?? def;
    } catch (_) { return def; }
  }

  // === chat-conversa-finalizar ===
  const conversaFinalizar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const motivo = p(req, 'motivo_fechamento');
    const usuario = p(req, 'usuario', 'sistema');
    const pular_template = p(req, 'pular_template', '') === 'true';
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `INSERT INTO chat_conversa_dono (conta_id, telefone, atendente, finalizada, finalizada_em, finalizada_por, motivo_fechamento, atribuido_em, atribuido_por)
       VALUES ($1,$2,'',true,NOW(),$3,$4,NOW(),$3)
       ON CONFLICT (conta_id, telefone) DO UPDATE
         SET finalizada=true, finalizada_em=NOW(), finalizada_por=$3, motivo_fechamento=$4`,
      [conta_id, telefone, usuario, motivo]
    );

    // Dispara template de encerramento (se configurado e nao foi solicitado pular)
    let template_enviado = null;
    if (!pular_template) {
      try {
        const [ativo, nome, lang, motivosExcluir] = await Promise.all([
          getConfigValue('encerramento_ativo', 'false'),
          getConfigValue('encerramento_template', ''),
          getConfigValue('encerramento_language', 'pt_BR'),
          getConfigValue('encerramento_motivos_excluir', ''),
        ]);
        const pular = motivosExcluir.split(',').map(s => s.trim()).filter(Boolean).includes(motivo);
        if (ativo === 'true' && nome && !pular) {
          // Busca o BODY do template na Meta pra gravar o texto real em chat_mensagens
          // (senao aparece "[template: nome]" na UI)
          let bodyText = '';
          try {
            const tpls = await fastify.inject({
              method: 'GET',
              url: '/webhook/chat-templates?conta_id=' + encodeURIComponent(conta_id),
            });
            const tplData = JSON.parse(tpls.body || '{}');
            const match = (tplData.templates || []).find(t =>
              t.name === nome && (!lang || t.language === lang)
            ) || (tplData.templates || []).find(t => t.name === nome);
            if (match) {
              const comp = (match.components || []).find(c => c.type === 'BODY');
              if (comp && comp.text) bodyText = comp.text;
            }
          } catch (_) { }
          const res = await fastify.inject({
            method: 'POST',
            url: '/webhook/chat-enviar',
            headers: { 'Content-Type': 'application/json' },
            payload: {
              token: 'ENCERRAMENTO_AUTO', usuario: 'sistema_encerramento',
              conta_id, telefone,
              tipo: 'template', template_name: nome, template_language: lang,
              template_body_text: bodyText,  // texto cru com placeholders {{1}} etc
              template_body_vars: [],         // nenhuma var — template eh estatico
            },
          });
          const body = JSON.parse(res.body || '{}');
          if (body.ok) template_enviado = nome;
        }
      } catch (_) { /* nao bloqueia finalizacao */ }
    }
    return { ok: true, template_enviado };
  });
  fastify.post('/webhook/chat-conversa-finalizar', conversaFinalizar);

  // === chat-config-encerramento (get/set) ===
  fastify.get('/webhook/chat-config-encerramento', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const [ativo, nome, lang, motivosExcluir] = await Promise.all([
      getConfigValue('encerramento_ativo', 'false'),
      getConfigValue('encerramento_template', ''),
      getConfigValue('encerramento_language', 'pt_BR'),
      getConfigValue('encerramento_motivos_excluir', ''),
    ]);
    return {
      ok: true,
      ativo: ativo === 'true',
      template: nome,
      language: lang,
      motivos_excluir: motivosExcluir.split(',').map(s => s.trim()).filter(Boolean),
    };
  });
  fastify.post('/webhook/chat-config-encerramento', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    await ensureConfigGlobal();
    const pairs = [
      ['encerramento_ativo', (b.ativo === true || b.ativo === 'true') ? 'true' : 'false'],
      ['encerramento_template', String(b.template || '').trim().substring(0, 120)],
      ['encerramento_language', String(b.language || 'pt_BR').trim().substring(0, 20) || 'pt_BR'],
      ['encerramento_motivos_excluir', Array.isArray(b.motivos_excluir) ? b.motivos_excluir.join(',') : String(b.motivos_excluir || '')],
    ];
    for (const [k, v] of pairs) {
      await query(
        `INSERT INTO chat_config_global (chave, valor, atualizado_em)
         VALUES ($1,$2,NOW())
         ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor, atualizado_em=NOW()`,
        [k, v]
      );
    }
    return { ok: true };
  });

  // === chat-conversa-reabrir ===
  const conversaReabrir = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const usuario = p(req, 'usuario', 'sistema');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    // motivo_fechamento tem NOT NULL constraint -> usa '' em vez de NULL
    await query(
      `UPDATE chat_conversa_dono SET finalizada=false, finalizada_em=NULL, motivo_fechamento=''
       WHERE conta_id=$1 AND telefone=$2`,
      [conta_id, telefone]
    );
    // Registra evento (silencioso se tabela nao existir)
    try {
      await query(
        `INSERT INTO chat_conversa_eventos (conta_id, telefone, tipo, ator, alvo, motivo, texto, criado_em)
         VALUES ($1,$2,'reabertura',$3,'','','Conversa reaberta',NOW())`,
        [conta_id, telefone, usuario]
      );
    } catch (_) { }
    return { ok: true };
  });
  fastify.post('/webhook/chat-conversa-reabrir', conversaReabrir);

  // === chat-conversa-transferir ===
  const conversaTransferir = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    // front manda 'novo_dono', alias legado 'novo_atendente'
    const novo_atendente = String(
      (req.body && (req.body.novo_dono ?? req.body.novo_atendente)) || ''
    ).toLowerCase().trim();
    const usuario = p(req, 'usuario', 'sistema');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    // Captura dono anterior pra registrar no evento
    const prev = await query(
      `SELECT atendente FROM chat_conversa_dono WHERE conta_id=$1 AND telefone=$2`,
      [conta_id, telefone]
    );
    const donoAnterior = (prev.rows[0]?.atendente || '').toLowerCase();
    const upd = await query(
      `UPDATE chat_conversa_dono
       SET atendente=$3, atribuido_em=NOW(), atribuido_por=$4
       WHERE conta_id=$1 AND telefone=$2`,
      [conta_id, telefone, novo_atendente, 'transfer:' + usuario]
    );
    if ((upd.rowCount || 0) === 0) {
      await query(
        `INSERT INTO chat_conversa_dono (conta_id, telefone, atendente, atribuido_em, atribuido_por, finalizada, motivo_fechamento)
         VALUES ($1,$2,$3,NOW(),$4,false,'')`,
        [conta_id, telefone, novo_atendente, 'transfer:' + usuario]
      );
    }
    // Registra evento interno pra aparecer no histórico do chat.html
    // Schema real: tipo, ator, alvo, motivo, texto, criado_em (lido pelo frontend como ev.ator/ev.alvo)
    try {
      const texto = donoAnterior
        ? `Transferido de ${donoAnterior} para ${novo_atendente}`
        : `Atribuído para ${novo_atendente}`;
      await query(
        `INSERT INTO chat_conversa_eventos (conta_id, telefone, tipo, ator, alvo, motivo, texto, criado_em)
         VALUES ($1,$2,'transferencia',$3,$4,'',$5,NOW())`,
        [conta_id, telefone, usuario, novo_atendente, texto]
      );
    } catch (_) { /* sem bloqueio se tabela/schema divergir */ }
    return { ok: true, atendente: novo_atendente };
  });
  fastify.post('/webhook/chat-conversa-transferir', conversaTransferir);

  // === chat-conversa-delete ===
  const conversaDelete = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(`DELETE FROM chat_mensagens WHERE conta_id=$1 AND telefone=$2`, [conta_id, telefone]);
    await query(`DELETE FROM chat_conversa_dono WHERE conta_id=$1 AND telefone=$2`, [conta_id, telefone]);
    await query(`DELETE FROM chat_conversa_etiquetas WHERE conta_id=$1 AND telefone=$2`, [conta_id, telefone]);
    return { ok: true };
  });
  fastify.post('/webhook/chat-conversa-delete', conversaDelete);

  // === chat-conversa-etiqueta-add ===
  const etiquetaAdd = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const etiqueta = p(req, 'etiqueta').substring(0, 200);
    const criado_por = p(req, 'usuario', 'sistema');
    if (!conta_id || !telefone || !etiqueta) return reply.code(400).send({ ok: false, erro: 'conta_id, telefone e etiqueta obrigatórios' });
    await query(
      `INSERT INTO chat_conversa_etiquetas (conta_id, telefone, etiqueta, origem, criado_por)
       VALUES ($1,$2,$3,'manual',$4) ON CONFLICT (conta_id, telefone, etiqueta) DO NOTHING`,
      [conta_id, telefone, etiqueta, criado_por]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-conversa-etiqueta-add', etiquetaAdd);

  // === chat-contato-save ===
  const contatoSave = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const nome = p(req, 'nome').substring(0, 200);
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `INSERT INTO chat_contatos_custom (conta_id, telefone, nome, atualizado_em)
       VALUES ($1,$2,$3,NOW()) ON CONFLICT (conta_id, telefone) DO UPDATE SET nome=$3, atualizado_em=NOW()`,
      [conta_id, telefone, nome]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-contato-save', contatoSave);

  // === chat-evento-registrar ===
  const eventoRegistrar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const tipo = p(req, 'tipo').substring(0, 60);
    const descricao = p(req, 'descricao').substring(0, 1000);
    const usuario = p(req, 'usuario', 'sistema');
    if (!conta_id || !telefone || !tipo) return reply.code(400).send({ ok: false, erro: 'conta_id, telefone, tipo obrigatórios' });
    await query(
      `INSERT INTO chat_conversa_eventos (conta_id, telefone, tipo, descricao, usuario, criado_em)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [conta_id, telefone, tipo, descricao, usuario]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-evento-registrar', eventoRegistrar);

  // === chat-tarefas-toggle ===
  const tarefasToggle = async (req, reply) => withDb(reply, async () => {
    const id = parseInt(p(req, 'id')) || 0;
    const feita = String(p(req, 'feita', 'true')) === 'true';
    if (!id) return reply.code(400).send({ ok: false, erro: 'id obrigatório' });
    await query(`UPDATE chat_tarefas_conversa SET feita=$2, atualizado_em=NOW() WHERE id=$1`, [id, feita]);
    return { ok: true };
  });
  fastify.post('/webhook/chat-tarefas-toggle', tarefasToggle);

  // === chat-manual-estado-set ===
  const manualEstadoSet = async (req, reply) => withDb(reply, async () => {
    const usuario = p(req, 'usuario');
    const no_atual = p(req, 'no_atual');
    const dados = p(req, 'dados', '{}');
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    await query(
      `INSERT INTO chat_manual_estado (usuario, no_atual, dados, atualizado_em)
       VALUES ($1,$2,$3::jsonb,NOW()) ON CONFLICT (usuario) DO UPDATE SET no_atual=$2, dados=$3::jsonb, atualizado_em=NOW()`,
      [usuario.toLowerCase(), no_atual, dados]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-manual-estado-set', manualEstadoSet);

  // === chat-retorno-criar ===
  // Schema varia entre instalacoes: autodetect colunas de data e nota.
  let _retornosSchema = null;
  async function detectarSchemaRetornos() {
    if (_retornosSchema) return _retornosSchema;
    // Garante tabela
    await query(`
      CREATE TABLE IF NOT EXISTS chat_retornos_agendados (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE,
        conta_id TEXT,
        telefone TEXT,
        atendente TEXT DEFAULT '',
        quando TIMESTAMPTZ,
        observacao TEXT DEFAULT '',
        status TEXT DEFAULT 'pendente',
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        concluido_em TIMESTAMPTZ
      )
    `).catch(() => {});
    // Pega colunas reais
    const r = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='chat_retornos_agendados'
    `);
    const cols = new Set(r.rows.map(x => x.column_name));
    _retornosSchema = {
      colData: cols.has('agendado_para') ? 'agendado_para' : (cols.has('quando') ? 'quando' : 'agendado_para'),
      colNota: cols.has('nota') ? 'nota' : (cols.has('observacao') ? 'observacao' : 'nota'),
      temCodigo: cols.has('codigo'),
      cols,
    };
    // Adiciona codigo se faltar (pra UPDATE/concluir funcionar).
    // Se tem 'id' (SERIAL), popula codigo = id::text; se nao tem, gera um
    if (!_retornosSchema.temCodigo) {
      await query(`ALTER TABLE chat_retornos_agendados ADD COLUMN IF NOT EXISTS codigo TEXT`).catch(() => {});
      if (cols.has('id')) {
        await query(`UPDATE chat_retornos_agendados SET codigo = id::text WHERE codigo IS NULL`).catch(() => {});
      }
      _retornosSchema.temCodigo = true;
    }
    return _retornosSchema;
  }

  const retornoCriar = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const atendente = String(b.atendente || b.usuario || '').toLowerCase();
    const agendado_para = String(b.quando || b.agendado_para || '').trim();
    const nota = String(b.observacao || b.nota || '').substring(0, 500);
    if (!conta_id || !telefone || !agendado_para) {
      return reply.code(400).send({ ok: false, erro: 'conta_id, telefone e quando (data) obrigatórios' });
    }
    const sch = await detectarSchemaRetornos();
    const codigo = 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    await query(
      `INSERT INTO chat_retornos_agendados (codigo, conta_id, telefone, atendente, ${sch.colData}, ${sch.colNota}, status)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6,'pendente')`,
      [codigo, conta_id, telefone, atendente, agendado_para, nota]
    );
    return { ok: true, codigo };
  });
  fastify.post('/webhook/chat-retorno-criar', retornoCriar);

  // === chat-retorno-concluir ===
  const retornoConcluir = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const codigo = String(b.codigo || '').trim();
    const id = parseInt(b.id) || 0;
    const novoStatus = String(b.status || 'concluido').substring(0, 30);
    if (!codigo && !id) return reply.code(400).send({ ok: false, erro: 'codigo ou id obrigatório' });

    // Detecta se a tabela tem 'concluido_em' — se nao, so atualiza status
    const colsR = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='chat_retornos_agendados'
    `).catch(() => ({ rows: [] }));
    const cols = new Set(colsR.rows.map(x => x.column_name));
    const temConcluidoEm = cols.has('concluido_em');
    const temId = cols.has('id');
    const temCodigo = cols.has('codigo');

    const whereSql = (id && temId) ? `id = $2` : (temCodigo ? `codigo = $2` : `id = $2`);
    const whereVal = (id && temId) ? id : (codigo || id);

    const returning = temCodigo ? 'codigo, status' : 'status';

    // Tenta com concluido_em primeiro; se der erro de coluna, refaz sem
    async function runUpdate(incluirCol) {
      const setExtra = incluirCol ? `, concluido_em = CASE WHEN $1='concluido' THEN NOW() ELSE concluido_em END` : '';
      return query(
        `UPDATE chat_retornos_agendados
         SET status=$1${setExtra}
         WHERE ${whereSql}
         RETURNING ${returning}`,
        [novoStatus, whereVal]
      );
    }
    let r;
    try {
      r = await runUpdate(temConcluidoEm);
    } catch (err) {
      // Qualquer erro relacionado a coluna inexistente: fallback sem
      if (/does not exist/i.test(err.message || '')) {
        r = await runUpdate(false);
      } else {
        throw err;
      }
    }
    if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'retorno não encontrado' });
    return { ok: true, status: r.rows[0].status, codigo: r.rows[0].codigo || codigo };
  });
  fastify.post('/webhook/chat-retorno-concluir', retornoConcluir);

  // === chat-triagem-ativar-conversa / desativar ===
  // Colunas corretas (mesmas usadas pelo engine em src/crons/triagem-engine.js):
  // triagem_codigo (nao config_codigo), ultima_atualizacao (nao atualizado_em),
  // iniciada_por (nao iniciado_em).
  const triagemAtivar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    // Aceita 'triagem_codigo' ou 'config_codigo' (alias legado)
    const triagem_codigo = String(
      (req.body?.triagem_codigo ?? req.body?.config_codigo ?? req.query?.triagem_codigo ?? req.query?.config_codigo ?? 'default')
    ).trim() || 'default';
    const usuario = p(req, 'usuario', 'manual');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    // Primeiro apaga sessao existente (nao tem UNIQUE constraint confiavel) e insere nova
    await query(
      `DELETE FROM chat_triagem_sessoes WHERE conta_id=$1 AND telefone=$2`,
      [conta_id, telefone]
    );
    await query(
      `INSERT INTO chat_triagem_sessoes (conta_id, telefone, triagem_codigo, passo_atual, status, iniciada_por, ultima_atualizacao)
       VALUES ($1,$2,$3,0,'ativa',$4,NOW())`,
      [conta_id, telefone, triagem_codigo, usuario]
    );
    return { ok: true, triagem_codigo };
  });
  fastify.post('/webhook/chat-triagem-ativar-conversa', triagemAtivar);

  const triagemDesativar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `UPDATE chat_triagem_sessoes SET status='encerrada', ultima_atualizacao=NOW() WHERE conta_id=$1 AND telefone=$2`,
      [conta_id, telefone]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-triagem-desativar-conversa', triagemDesativar);

  // === chat-atendentes-save (upsert) ===
  // Aceita papel/role, senha opcional (só atualiza se enviada),
  // contas_permitidas como array, CSV "a,b,c", "*" (todas) ou "__none__" (nenhuma)
  const atendentesSave = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const usuario = String(b.usuario || '').toLowerCase().trim();
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    const nome = String(b.nome || '').substring(0, 100);
    const senha = String(b.senha || '');
    // Front manda USER/ADM/SUPER — aceita papel OU role
    const papel = String(b.papel || b.role || 'USER').toUpperCase();
    const ativo = b.ativo !== false;
    const foto_url = String(b.foto_url || '');

    // Normaliza contas_permitidas:
    // - array: usa direto
    // - "__none__": array vazio (sem acesso a nada)
    // - "*": acesso total
    // - "a,b,c": CSV — split em vírgula
    // - "meta_xxx": 1 conta só
    let contas_permitidas;
    if (Array.isArray(b.contas_permitidas)) {
      contas_permitidas = b.contas_permitidas.filter(x => x && String(x).trim());
    } else if (b.contas_permitidas === '__none__') {
      contas_permitidas = [];
    } else if (typeof b.contas_permitidas === 'string' && b.contas_permitidas.trim()) {
      contas_permitidas = b.contas_permitidas.split(',').map(x => x.trim()).filter(Boolean);
    } else {
      contas_permitidas = ['*'];
    }

    const sqlInsert = `INSERT INTO chat_atendentes (usuario, nome, senha, papel, ativo, foto_url, contas_permitidas)
                       VALUES ($1,$2,$3,$4,$5,$6,$7::text[])
                       ON CONFLICT (usuario) DO UPDATE
                         SET nome=$2, papel=$4, ativo=$5, foto_url=$6, contas_permitidas=$7::text[]
                         ${senha ? `, senha=$3` : ''}`;
    await query(sqlInsert, [usuario, nome, senha, papel, ativo, foto_url, contas_permitidas]);
    return { ok: true };
  });
  fastify.post('/webhook/chat-atendentes-save', atendentesSave);

  // === chat-horario-get / chat-horario-save ===
  // CRUD do chat_atendentes_horario (usado em atendentes.html / modal "Editar atendente").
  async function ensureHorarioTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_atendentes_horario (
        usuario VARCHAR(80) PRIMARY KEY,
        horario_inicio TIME,
        horario_fim TIME,
        almoco_inicio TIME,
        almoco_fim TIME,
        horario_sab_inicio TIME,
        horario_sab_fim TIME,
        dias_semana TEXT DEFAULT '1,2,3,4,5',
        sabados_ativos TEXT DEFAULT 'todos',
        modo_fila VARCHAR(20) DEFAULT 'manual',
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
  }
  const horarioGet = async (req, reply) => withDb(reply, async () => {
    const usuario = String(p(req, 'usuario', '')).toLowerCase().trim();
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    await ensureHorarioTable();
    const r = await query(
      `SELECT usuario,
              to_char(horario_inicio,'HH24:MI') AS horario_inicio,
              to_char(horario_fim,'HH24:MI')    AS horario_fim,
              to_char(almoco_inicio,'HH24:MI')  AS almoco_inicio,
              to_char(almoco_fim,'HH24:MI')     AS almoco_fim,
              to_char(horario_sab_inicio,'HH24:MI') AS horario_sab_inicio,
              to_char(horario_sab_fim,'HH24:MI')    AS horario_sab_fim,
              dias_semana, sabados_ativos, modo_fila
       FROM chat_atendentes_horario WHERE LOWER(usuario)=LOWER($1)`,
      [usuario]
    );
    if (!r.rows.length) return { ok: true, vazio: true };
    return { ok: true, ...r.rows[0] };
  });
  fastify.get('/webhook/chat-horario-get', horarioGet);
  fastify.post('/webhook/chat-horario-get', horarioGet);

  const horarioSave = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const usuario = String(b.usuario || '').toLowerCase().trim();
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    await ensureHorarioTable();
    // Normaliza strings de hora vazias pra NULL (campos sao TIME nullable)
    const nz = (v) => { const s = String(v || '').trim(); return s ? s : null; };
    const modo = (String(b.modo_fila || 'manual').toLowerCase() === 'auto') ? 'auto' : 'manual';
    const dias = String(b.dias_semana || '1,2,3,4,5').trim() || '1,2,3,4,5';
    const sabs = String(b.sabados_ativos ?? 'todos'); // vazio = 'nunca marca' (string vazia)
    await query(
      `INSERT INTO chat_atendentes_horario
         (usuario, horario_inicio, horario_fim, almoco_inicio, almoco_fim,
          horario_sab_inicio, horario_sab_fim, dias_semana, sabados_ativos, modo_fila, atualizado_em)
       VALUES ($1,$2::time,$3::time,$4::time,$5::time,$6::time,$7::time,$8,$9,$10,NOW())
       ON CONFLICT (usuario) DO UPDATE SET
         horario_inicio=EXCLUDED.horario_inicio,
         horario_fim=EXCLUDED.horario_fim,
         almoco_inicio=EXCLUDED.almoco_inicio,
         almoco_fim=EXCLUDED.almoco_fim,
         horario_sab_inicio=EXCLUDED.horario_sab_inicio,
         horario_sab_fim=EXCLUDED.horario_sab_fim,
         dias_semana=EXCLUDED.dias_semana,
         sabados_ativos=EXCLUDED.sabados_ativos,
         modo_fila=EXCLUDED.modo_fila,
         atualizado_em=NOW()`,
      [usuario, nz(b.horario_inicio), nz(b.horario_fim),
        nz(b.almoco_inicio), nz(b.almoco_fim),
        nz(b.horario_sab_inicio), nz(b.horario_sab_fim),
        dias, sabs, modo]
    );
    return { ok: true, usuario, modo_fila: modo };
  });
  fastify.post('/webhook/chat-horario-save', horarioSave);

  // === Helpers de expediente ===
  // Horario comercial GLOBAL (usado pra escolher fila principal vs pos-expediente).
  // Pode sobrescrever via env: EXPEDIENTE_HORA_INI=8, EXPEDIENTE_HORA_FIM=18
  const EXP_INI = parseInt(process.env.EXPEDIENTE_HORA_INI || '8', 10);
  const EXP_FIM = parseInt(process.env.EXPEDIENTE_HORA_FIM || '18', 10);
  // Dias da semana ativos (1=seg...7=dom). Default seg-sex.
  const EXP_DIAS = String(process.env.EXPEDIENTE_DIAS || '1,2,3,4,5').split(',').map(x => parseInt(x,10)).filter(Boolean);
  function agoraEhExpedienteGlobal() {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dow = agora.getDay(); const diaBR = dow === 0 ? 7 : dow;
    if (!EXP_DIAS.includes(diaBR)) return false;
    const h = agora.getHours();
    return h >= EXP_INI && h < EXP_FIM;
  }
  // Verifica se um atendente especifico esta dentro do SEU horario (chat_atendentes_horario)
  // Se nao tem linha ou modo!=auto, retorna true (sem restricao).
  async function atendenteDentroDoHorario(usuario) {
    try {
      const r = await query(
        `SELECT to_char(horario_inicio,'HH24:MI') AS ini, to_char(horario_fim,'HH24:MI') AS fim,
                to_char(almoco_inicio,'HH24:MI') AS ai, to_char(almoco_fim,'HH24:MI') AS af,
                to_char(horario_sab_inicio,'HH24:MI') AS sab_ini, to_char(horario_sab_fim,'HH24:MI') AS sab_fim,
                dias_semana, sabados_ativos, modo_fila
         FROM chat_atendentes_horario WHERE LOWER(usuario)=LOWER($1)`, [usuario]
      );
      if (!r.rows.length) return true;
      const h = r.rows[0];
      if (String(h.modo_fila || 'manual') !== 'auto') return true;
      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const dow = agora.getDay(); const diaBR = dow === 0 ? 7 : dow;
      const hhmm = (s) => { if (!s) return null; const [a,b] = s.split(':').map(Number); return a*60+(b||0); };
      const diasOk = String(h.dias_semana || '').split(',').map(Number).includes(diaBR);
      if (!diasOk) return false;
      let ini, fim, ai = null, af = null;
      if (diaBR === 6 && h.sab_ini && h.sab_fim) {
        // Checa sabado especifico
        const sab = String(h.sabados_ativos || 'todos').trim();
        if (sab !== 'todos') {
          const ordensSab = sab.split(',').map(Number);
          const ordemSabado = Math.ceil(agora.getDate() / 7);
          if (!ordensSab.includes(ordemSabado)) return false;
        }
        ini = hhmm(h.sab_ini); fim = hhmm(h.sab_fim);
      } else {
        ini = hhmm(h.ini); fim = hhmm(h.fim); ai = hhmm(h.ai); af = hhmm(h.af);
      }
      const horaMin = agora.getHours() * 60 + agora.getMinutes();
      if (ini == null || fim == null || horaMin < ini || horaMin >= fim) return false;
      if (ai != null && af != null && horaMin >= ai && horaMin < af) return false;
      return true;
    } catch (_) { return true; }
  }

  // === chat-fila-toggle ===
  // Liga/desliga a chavinha "na_fila" OU "fila_apos_expediente" de um atendente.
  // body: { usuario, na_fila?, fila_apos_expediente?, forcar? }
  // Se tentar ativar na_fila=true fora do horario do atendente (modo auto),
  // retorna 400 com dica — a menos que passe forcar=true.
  const filaToggle = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const usuario = String(b.usuario || '').toLowerCase().trim();
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    // Garante coluna fila_apos_expediente
    await query(`ALTER TABLE chat_atendentes ADD COLUMN IF NOT EXISTS fila_apos_expediente BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    const temCampoAlt = ('fila_apos_expediente' in b);
    const forcar = b.forcar === true || b.forcar === 'true';

    if (temCampoAlt) {
      const val = b.fila_apos_expediente === true || b.fila_apos_expediente === 'true' || b.fila_apos_expediente === 1;
      const r = await query(
        `UPDATE chat_atendentes SET fila_apos_expediente=$2 WHERE LOWER(usuario)=LOWER($1) RETURNING usuario, na_fila, fila_apos_expediente`,
        [usuario, val]
      );
      if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'usuario não encontrado' });
      return { ok: true, usuario: r.rows[0].usuario, na_fila: r.rows[0].na_fila, fila_apos_expediente: r.rows[0].fila_apos_expediente };
    }

    const na_fila = b.na_fila === true || b.na_fila === 'true' || b.na_fila === 1;
    // Se tenta ativar fora do horario e nao forcou, bloqueia
    if (na_fila && !forcar) {
      const dentro = await atendenteDentroDoHorario(usuario);
      if (!dentro) {
        return reply.code(400).send({
          ok: false,
          erro: 'fora_horario',
          mensagem: 'Você está fora do seu horário de atendimento. Entre na "Fila pós-expediente" ou aguarde seu expediente iniciar.',
        });
      }
    }
    const r = await query(
      `UPDATE chat_atendentes SET na_fila=$2 WHERE LOWER(usuario)=LOWER($1) RETURNING usuario, na_fila, COALESCE(fila_apos_expediente,false) AS fila_apos_expediente`,
      [usuario, na_fila]
    );
    if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'usuario não encontrado' });
    return { ok: true, usuario: r.rows[0].usuario, na_fila: r.rows[0].na_fila, fila_apos_expediente: r.rows[0].fila_apos_expediente };
  });
  fastify.post('/webhook/chat-fila-toggle', filaToggle);

  // === chat-fila-status / chat-fila-config ===
  // Migrados do workflow-fila-distribuicao do n8n (que usava Data Table do n8n).
  // Agora leem de chat_atendentes (na_fila/ativo/papel) + chat_fila_config (singleton).
  async function ensureFilaConfigTable() {
    // Idempotente e tolerante a tabela pre-existente (schema antigo do n8n sem coluna id).
    await query(`
      CREATE TABLE IF NOT EXISTS chat_fila_config (
        ativa BOOLEAN NOT NULL DEFAULT true,
        ultimo_atribuido VARCHAR(80) NOT NULL DEFAULT '',
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Garante colunas (caso tabela ja existisse com outro schema do n8n)
    await query(`ALTER TABLE chat_fila_config ADD COLUMN IF NOT EXISTS ativa BOOLEAN NOT NULL DEFAULT true`);
    await query(`ALTER TABLE chat_fila_config ADD COLUMN IF NOT EXISTS ultimo_atribuido VARCHAR(80) NOT NULL DEFAULT ''`);
    await query(`ALTER TABLE chat_fila_config ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    // Garante exatamente 1 linha (singleton)
    const n = await query(`SELECT COUNT(*)::int AS c FROM chat_fila_config`);
    if ((n.rows[0]?.c || 0) === 0) {
      await query(`INSERT INTO chat_fila_config (ativa, ultimo_atribuido) VALUES (true, '')`);
    }
  }

  const filaStatus = async (req, reply) => withDb(reply, async () => {
    await ensureFilaConfigTable();
    const cfg = await query(`SELECT ativa, ultimo_atribuido FROM chat_fila_config LIMIT 1`);
    const c = cfg.rows[0] || { ativa: true, ultimo_atribuido: '' };
    await query(`ALTER TABLE chat_atendentes ADD COLUMN IF NOT EXISTS fila_apos_expediente BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    const rows = await query(
      `SELECT LOWER(a.usuario) AS usuario,
              COALESCE(a.nome, a.usuario) AS nome,
              COALESCE(a.foto_url,'') AS foto_url,
              COALESCE(a.na_fila,false) AS na_fila,
              COALESCE(a.fila_apos_expediente,false) AS fila_apos_expediente,
              COALESCE(cnt.backlog, 0)::int AS backlog
       FROM chat_atendentes a
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS backlog
         FROM chat_conversa_dono cd
         WHERE LOWER(cd.atendente) = LOWER(a.usuario)
           AND COALESCE(cd.finalizada, false) = false
       ) cnt ON true
       WHERE COALESCE(a.ativo,true)=true
         AND LOWER(COALESCE(a.papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
         AND LOWER(a.usuario) <> 'admin'
       ORDER BY a.usuario`
    );
    const inFila = rows.rows.filter(a => a.na_fila === true);
    const foraFila = rows.rows.filter(a => a.na_fila !== true);
    const inFilaPos = rows.rows.filter(a => a.fila_apos_expediente === true);
    const foraFilaPos = rows.rows.filter(a => a.fila_apos_expediente !== true);
    const ultimo = String(c.ultimo_atribuido || '').toLowerCase();
    const expedienteAgora = agoraEhExpedienteGlobal();
    // Proximo a receber: mesma lógica do chat-fila-proximo (menor carga + desempate por atribuicao mais antiga)
    let proximo = null;
    if (inFila.length) {
      const nextRes = await query(
        `SELECT LOWER(a.usuario) AS usuario,
                COALESCE(a.nome, a.usuario) AS nome,
                COALESCE(a.foto_url,'') AS foto_url,
                COALESCE(cnt.backlog, 0)::int AS backlog
         FROM chat_atendentes a
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS backlog, MAX(atribuido_em) AS ultima_em
           FROM chat_conversa_dono cd
           WHERE LOWER(cd.atendente) = LOWER(a.usuario)
             AND COALESCE(cd.finalizada, false) = false
         ) cnt ON true
         WHERE COALESCE(a.ativo,true)=true AND COALESCE(a.na_fila,false)=true
           AND LOWER(COALESCE(a.papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
           AND LOWER(a.usuario) <> 'admin'
         ORDER BY backlog ASC, cnt.ultima_em ASC NULLS FIRST, a.usuario ASC
         LIMIT 1`
      );
      proximo = nextRes.rows[0] || null;
    }
    return {
      ok: true,
      ativa: c.ativa !== false,
      ultimo_atribuido: ultimo,
      proximo,
      expediente_agora: expedienteAgora,
      expediente: { hora_ini: EXP_INI, hora_fim: EXP_FIM, dias: EXP_DIAS },
      in_fila: inFila.map(a => ({ usuario: a.usuario, nome: a.nome, foto_url: a.foto_url, backlog: a.backlog })),
      fora_fila: foraFila.map(a => ({ usuario: a.usuario, nome: a.nome, foto_url: a.foto_url, backlog: a.backlog })),
      in_fila_pos: inFilaPos.map(a => ({ usuario: a.usuario, nome: a.nome, foto_url: a.foto_url, backlog: a.backlog })),
      fora_fila_pos: foraFilaPos.map(a => ({ usuario: a.usuario, nome: a.nome, foto_url: a.foto_url, backlog: a.backlog })),
    };
  });
  fastify.get('/webhook/chat-fila-status', filaStatus);
  fastify.post('/webhook/chat-fila-status', filaStatus);

  const filaConfig = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    await ensureFilaConfigTable();
    const ativa = (b.ativa === true || b.ativa === 'true' || b.ativa === 1);
    const resetar = (b.resetar === true || b.resetar === 'true' || b.resetar === 1);
    if (resetar) {
      await query(`UPDATE chat_fila_config SET ativa=$1, ultimo_atribuido='', atualizado_em=NOW()`, [ativa]);
    } else {
      await query(`UPDATE chat_fila_config SET ativa=$1, atualizado_em=NOW()`, [ativa]);
    }
    const r = await query(`SELECT ativa, ultimo_atribuido FROM chat_fila_config LIMIT 1`);
    return { ok: true, ativa: r.rows[0].ativa, ultimo_atribuido: r.rows[0].ultimo_atribuido };
  });
  fastify.post('/webhook/chat-fila-config', filaConfig);

  // === chat-fila-proximo ===
  // Devolve o proximo da fila com estrategia "menor carga":
  // 1. Conta conversas ABERTAS (nao finalizadas) de cada consultor na fila
  // 2. Escolhe o de menor contagem
  // 3. Desempate: quem recebeu ha mais tempo (MAX(atribuido_em) ASC NULLS FIRST)
  //    -> quem nunca recebeu entra primeiro; empate real resolve alfabetico
  // Avanca ultimo_atribuido como historico (nao eh mais usado pra round-robin).
  const filaProximo = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const conta_id = String(b.conta_id || '').trim();
    const telefone = String(b.telefone || '').trim();
    await ensureFilaConfigTable();
    const cfg = await query(`SELECT ativa FROM chat_fila_config LIMIT 1`);
    const ativa = cfg.rows[0] ? cfg.rows[0].ativa !== false : true;
    if (!ativa) return { ok: false, sem_fila: true, erro: 'fila desativada' };
    await query(`ALTER TABLE chat_atendentes ADD COLUMN IF NOT EXISTS fila_apos_expediente BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    // Dentro do expediente -> fila principal (na_fila)
    // Fora do expediente   -> fila pos-expediente (fila_apos_expediente)
    const expedienteAgora = agoraEhExpedienteGlobal();
    const colFila = expedienteAgora ? 'a.na_fila' : 'a.fila_apos_expediente';
    const rows = await query(
      `SELECT LOWER(a.usuario) AS usuario,
              COALESCE(a.nome, a.usuario) AS nome,
              COALESCE(cnt.backlog, 0)::int AS backlog,
              cnt.ultima_em
       FROM chat_atendentes a
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS backlog, MAX(atribuido_em) AS ultima_em
         FROM chat_conversa_dono cd
         WHERE LOWER(cd.atendente) = LOWER(a.usuario)
           AND COALESCE(cd.finalizada, false) = false
       ) cnt ON true
       WHERE COALESCE(a.ativo,true)=true
         AND COALESCE(${colFila},false)=true
         AND LOWER(COALESCE(a.papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
         AND LOWER(a.usuario) <> 'admin'
       ORDER BY backlog ASC, ultima_em ASC NULLS FIRST, a.usuario ASC
       LIMIT 1`
    );
    if (!rows.rows.length) {
      const nomeFila = expedienteAgora ? 'principal' : 'pós-expediente';
      return { ok: false, sem_fila: true, erro: `nenhum consultor na fila ${nomeFila}`, expediente_agora: expedienteAgora };
    }
    const prox = rows.rows[0];
    await query(`UPDATE chat_fila_config SET ultimo_atribuido=$1, atualizado_em=NOW()`, [prox.usuario]);
    return {
      ok: true,
      conta_id, telefone,
      usuario_escolhido: prox.usuario,
      nome_escolhido: prox.nome,
      backlog_atual: prox.backlog,
      fila_usada: expedienteAgora ? 'principal' : 'pos_expediente',
    };
  });
  fastify.post('/webhook/chat-fila-proximo', filaProximo);

  // === chat-finalizar-antigas-preview ===
  // Body: { antes_de: 'YYYY-MM-DD' }  -> conta quantas seriam finalizadas
  // Conversas "antigas" = cuja ULTIMA msg (direcao qualquer) eh ANTES de antes_de 00:00 BRT
  // Ignora conversas ja finalizadas.
  const SQL_ANTIGAS_COUNT = `
    WITH ult AS (
      SELECT conta_id, telefone, MAX(timestamp) AS ultima
      FROM chat_mensagens
      GROUP BY conta_id, telefone
    )
    SELECT COUNT(*)::int AS total
    FROM ult u
    LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
    WHERE u.ultima < ($1::date AT TIME ZONE 'America/Sao_Paulo')
      AND COALESCE(cd.finalizada, false) = false
  `;
  const previewAntigas = async (req, reply) => withDb(reply, async () => {
    const antes_de = String((req.body || {}).antes_de || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(antes_de)) {
      return reply.code(400).send({ ok: false, erro: 'antes_de deve ser YYYY-MM-DD' });
    }
    const r = await query(SQL_ANTIGAS_COUNT, [antes_de]);
    return { ok: true, total: r.rows[0]?.total || 0, antes_de };
  });
  fastify.post('/webhook/chat-finalizar-antigas-preview', previewAntigas);

  // === chat-finalizar-antigas ===
  // Body: { antes_de: 'YYYY-MM-DD', motivo?: '', usuario?: '' }
  // UPDATE em massa: marca finalizada=true, grava motivo_fechamento, finalizada_em=NOW().
  // Faz INSERT em chat_conversa_dono pras que ainda nao tem linha.
  // Registra 1 evento por conversa pra auditoria.
  const finalizarAntigas = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const antes_de = String(b.antes_de || '').trim();
    const motivo = String(b.motivo || '').substring(0, 80);
    const usuario = String(b.usuario || 'admin').substring(0, 80);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(antes_de)) {
      return reply.code(400).send({ ok: false, erro: 'antes_de deve ser YYYY-MM-DD' });
    }
    // 1. Levanta quais conversas serao afetadas (pra INSERT e evento)
    const alvos = await query(
      `WITH ult AS (
         SELECT conta_id, telefone, MAX(timestamp) AS ultima
         FROM chat_mensagens
         GROUP BY conta_id, telefone
       )
       SELECT u.conta_id, u.telefone, (cd.conta_id IS NULL) AS novo
       FROM ult u
       LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
       WHERE u.ultima < ($1::date AT TIME ZONE 'America/Sao_Paulo')
         AND COALESCE(cd.finalizada, false) = false`,
      [antes_de]
    );
    if (!alvos.rows.length) return { ok: true, finalizadas: 0, antes_de };

    // 2. INSERT pras conversas sem linha em chat_conversa_dono
    const sem_dono = alvos.rows.filter(r => r.novo);
    for (const s of sem_dono) {
      await query(
        `INSERT INTO chat_conversa_dono (conta_id, telefone, atendente, atribuido_em, atribuido_por, finalizada, motivo_fechamento, finalizada_em)
         VALUES ($1,$2,'',NOW(),$3,true,$4,NOW())
         ON CONFLICT (conta_id, telefone) DO NOTHING`,
        [s.conta_id, s.telefone, 'finalizacao_antigas:' + usuario, motivo]
      ).catch(() => {});
    }

    // 3. UPDATE em massa
    const upd = await query(
      `UPDATE chat_conversa_dono cd
       SET finalizada=true,
           motivo_fechamento=$2,
           finalizada_em=NOW()
       FROM (
         SELECT conta_id, telefone, MAX(timestamp) AS ultima
         FROM chat_mensagens GROUP BY conta_id, telefone
       ) u
       WHERE cd.conta_id=u.conta_id AND cd.telefone=u.telefone
         AND u.ultima < ($1::date AT TIME ZONE 'America/Sao_Paulo')
         AND COALESCE(cd.finalizada, false) = false`,
      [antes_de, motivo]
    );

    // 4. Grava 1 evento por conversa (silencioso se tabela nao existir)
    const texto = `Finalizada em massa (última msg antes de ${antes_de})`;
    for (const a of alvos.rows) {
      try {
        await query(
          `INSERT INTO chat_conversa_eventos (conta_id, telefone, tipo, ator, alvo, motivo, texto, criado_em)
           VALUES ($1,$2,'finalizacao',$3,'',$4,$5,NOW())`,
          [a.conta_id, a.telefone, usuario, motivo, texto]
        );
      } catch (_) { }
    }

    return { ok: true, finalizadas: upd.rowCount || alvos.rows.length, antes_de, motivo };
  });
  fastify.post('/webhook/chat-finalizar-antigas', finalizarAntigas);

  // === chat-vapo-listar ===
  // Lista leads que estouraram o timeout de primeira resposta e foram realocados.
  // Params: periodo (dias, default 7), consultor (filtra por dono_antigo),
  //         so_fallback (bool), incluir_resolvidos (bool, default false),
  //         limit (default 500)
  //
  // Default: so' mostra casos AINDA PENDENTES — conversa nao finalizada E
  // nenhuma msg 'out' humana depois do criado_em do log. Assim o painel
  // vira "caixa de alerta": chat respondido/finalizado desaparece da lista.
  const vapoListar = async (req, reply) => withDb(reply, async () => {
    const q = req.query || {};
    const periodo = Math.max(1, Math.min(90, parseInt(q.periodo || '7', 10)));
    const consultor = String(q.consultor || '').toLowerCase().trim();
    const soFallback = String(q.so_fallback || '') === 'true';
    const incluirResolvidos = String(q.incluir_resolvidos || 'false') === 'true';
    const limit = Math.max(1, Math.min(2000, parseInt(q.limit || '500', 10)));

    // Garante tabela (sem travar se cron ainda nao rodou)
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
    `).catch(() => {});

    // Pega apenas o ultimo log de cada (conta_id, telefone) — se um lead caiu
    // no VAPO 3x ate ser resolvido, mostra so a ultima entrada.
    const params = [periodo, limit];
    let where = `l.criado_em > NOW() - ($1::int || ' days')::interval`;
    if (consultor) { params.push(consultor); where += ` AND LOWER(l.dono_antigo) = $${params.length}`; }
    if (soFallback) where += ` AND l.fallback = true`;
    if (!incluirResolvidos) {
      // Resolvido = conversa finalizada OU ja tem msg out humana depois do log
      where += `
        AND COALESCE(cd.finalizada, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM chat_mensagens m
          WHERE m.conta_id = l.conta_id
            AND m.telefone = l.telefone
            AND m.direcao = 'out'
            AND m.timestamp >= l.criado_em
            AND LOWER(COALESCE(m.atendente,'')) NOT IN (
              'sistema','ia_followup','triagem_ia','triagem','admin',
              'redistribuicao_auto','sistema_encerramento','encerramento_auto',
              'vapo_auto','auto_finalizar',''
            )
            AND LOWER(COALESCE(m.atendente,'')) NOT LIKE 'disparo%'
            AND LOWER(COALESCE(m.atendente,'')) NOT LIKE '%_auto'
        )
      `;
    }

    const r = await query(
      `WITH ult AS (
         SELECT DISTINCT ON (conta_id, telefone) *
         FROM chat_vapo_log
         WHERE criado_em > NOW() - ($1::int || ' days')::interval
         ORDER BY conta_id, telefone, criado_em DESC
       )
       SELECT l.id, l.conta_id, l.telefone, l.nome_contato,
              LOWER(l.dono_antigo) AS dono_antigo,
              LOWER(l.dono_novo) AS dono_novo,
              l.minutos_sem_resposta, l.motivo, l.fallback, l.criado_em,
              COALESCE(cd.finalizada, false) AS conv_finalizada
       FROM ult l
       LEFT JOIN chat_conversa_dono cd
         ON cd.conta_id = l.conta_id AND cd.telefone = l.telefone
       WHERE ${where}
       ORDER BY l.criado_em DESC
       LIMIT $2`,
      params
    );

    // Ranking agregado (respeita so_fallback e incluir_resolvidos)
    const rkParams = [periodo];
    let rkWhere = `l.criado_em > NOW() - ($1::int || ' days')::interval`;
    if (soFallback) rkWhere += ` AND l.fallback = true`;
    if (!incluirResolvidos) {
      rkWhere += `
        AND COALESCE(cd.finalizada, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM chat_mensagens m
          WHERE m.conta_id = l.conta_id
            AND m.telefone = l.telefone
            AND m.direcao = 'out'
            AND m.timestamp >= l.criado_em
            AND LOWER(COALESCE(m.atendente,'')) NOT IN (
              'sistema','ia_followup','triagem_ia','triagem','admin',
              'redistribuicao_auto','sistema_encerramento','encerramento_auto',
              'vapo_auto','auto_finalizar',''
            )
            AND LOWER(COALESCE(m.atendente,'')) NOT LIKE 'disparo%'
            AND LOWER(COALESCE(m.atendente,'')) NOT LIKE '%_auto'
        )
      `;
    }
    const rk = await query(
      `WITH ult AS (
         SELECT DISTINCT ON (conta_id, telefone) *
         FROM chat_vapo_log
         WHERE criado_em > NOW() - ($1::int || ' days')::interval
         ORDER BY conta_id, telefone, criado_em DESC
       )
       SELECT LOWER(l.dono_antigo) AS dono, COUNT(*)::int AS total,
              SUM(CASE WHEN l.fallback THEN 1 ELSE 0 END)::int AS para_fallback
       FROM ult l
       LEFT JOIN chat_conversa_dono cd
         ON cd.conta_id = l.conta_id AND cd.telefone = l.telefone
       WHERE ${rkWhere}
       GROUP BY LOWER(l.dono_antigo)
       ORDER BY total DESC`,
      rkParams
    );

    return {
      ok: true,
      periodo_dias: periodo,
      total: r.rows.length,
      incluir_resolvidos: incluirResolvidos,
      itens: r.rows,
      ranking_perdedores: rk.rows,
    };
  });
  fastify.get('/webhook/chat-vapo-listar', vapoListar);
  fastify.post('/webhook/chat-vapo-listar', vapoListar);

  // === chat-atendente-delete ===
  // Remove um atendente (respostas rapidas e historico ficam, via FK ou nao)
  const atendenteDelete = async (req, reply) => withDb(reply, async () => {
    const usuario = String((req.body || {}).usuario || '').toLowerCase().trim();
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    if (usuario === 'admin') return reply.code(400).send({ ok: false, erro: 'nao pode deletar admin' });
    const r = await query(`DELETE FROM chat_atendentes WHERE LOWER(usuario)=LOWER($1) RETURNING usuario`, [usuario]);
    if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'nao encontrado' });
    return { ok: true, usuario: r.rows[0].usuario };
  });
  fastify.post('/webhook/chat-atendente-delete', atendenteDelete);
  fastify.post('/webhook/chat-atendentes-delete', atendenteDelete);

  // === chat-conversas-distribuir ===
  // Payload: { conversas: [{conta_id, telefone}, ...], modo, atendente?, atendentes?, quem }
  // modo='atendente': atribui todas ao usuario escolhido (unico)
  // modo='equipe': distribui round-robin entre atendentes com na_fila=true
  // modo='selecionados': round-robin apenas entre a lista 'atendentes' passada
  const conversasDistribuir = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const conversas = Array.isArray(b.conversas) ? b.conversas : [];
    const modo = String(b.modo || 'equipe').toLowerCase();
    const atendenteAlvo = String(b.atendente || '').toLowerCase().trim();
    const atendentesLista = Array.isArray(b.atendentes)
      ? b.atendentes.map(a => String(a||'').toLowerCase().trim()).filter(Boolean)
      : [];
    const quem = String(b.quem || b.usuario || 'sistema').toLowerCase();

    if (!conversas.length) return reply.code(400).send({ ok: false, erro: 'sem conversas' });
    if (modo === 'atendente' && !atendenteAlvo) {
      return reply.code(400).send({ ok: false, erro: 'atendente obrigatorio no modo atendente' });
    }
    if (modo === 'selecionados' && !atendentesLista.length) {
      return reply.code(400).send({ ok: false, erro: 'escolha pelo menos 1 consultor' });
    }

    // Lista de destinos
    let destinos = [];
    if (modo === 'atendente') {
      destinos = [atendenteAlvo];
    } else if (modo === 'selecionados') {
      // dedup preservando ordem
      destinos = Array.from(new Set(atendentesLista));
    } else {
      // modo equipe: pega atendentes ATIVOS e NA_FILA
      const r = await query(
        `SELECT LOWER(usuario) AS usuario FROM chat_atendentes
         WHERE COALESCE(ativo,true)=true AND COALESCE(na_fila,false)=true
           AND LOWER(COALESCE(papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
         ORDER BY usuario`
      );
      destinos = r.rows.map(x => x.usuario).filter(Boolean);
      if (!destinos.length) {
        return reply.code(400).send({ ok: false, erro: 'nenhum atendente na fila (ative no painel Fila)' });
      }
    }

    // Round-robin — usa UPDATE-primeiro-INSERT-se-nao-pegou pra nao depender
    // de UNIQUE (conta_id, telefone) estar certa no schema
    const resumoMap = new Map();
    let i = 0;
    let atualizados = 0, criados = 0;
    for (const c of conversas) {
      const conta_id = String(c.conta_id || '');
      const telefone = String(c.telefone || '');
      if (!conta_id || !telefone) continue;
      const dest = destinos[i % destinos.length];
      i++;
      const upd = await query(
        `UPDATE chat_conversa_dono
         SET atendente=$3, atribuido_em=NOW(), atribuido_por=$4,
             finalizada=false, finalizada_em=NULL, motivo_fechamento=''
         WHERE conta_id=$1 AND telefone=$2`,
        [conta_id, telefone, dest, 'dist:' + quem]
      );
      if ((upd.rowCount || 0) === 0) {
        await query(
          `INSERT INTO chat_conversa_dono (conta_id, telefone, atendente, atribuido_em, atribuido_por, finalizada, motivo_fechamento)
           VALUES ($1,$2,$3,NOW(),$4,false,'')`,
          [conta_id, telefone, dest, 'dist:' + quem]
        );
        criados++;
      } else {
        atualizados += (upd.rowCount || 0);
      }
      resumoMap.set(dest, (resumoMap.get(dest) || 0) + 1);
    }
    const resumo = Array.from(resumoMap.entries()).map(([atendente, qtd]) => ({ atendente, qtd }));
    return { ok: true, total: i, atualizados, criados, resumo };
  });
  fastify.post('/webhook/chat-conversas-distribuir', conversasDistribuir);
  fastify.post('/api/chat/conversas-distribuir', conversasDistribuir);

  // === hubspot-search-deals (stub) ===
  // O chat chama isso pra decorar o header "has-hubspot". Enquanto a
  // integracao HubSpot nao estiver migrada, retorna vazio pra parar
  // os 500 no console. Se precisar da integracao real, implementar
  // aqui com HUBSPOT_API_KEY do env.
  fastify.post('/webhook/hubspot-search-deals', async () => ({
    ok: true, contatos: [], deals: [], stub: true,
  }));
}
