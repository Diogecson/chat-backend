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
  // === chat-conversa-finalizar ===
  const conversaFinalizar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const motivo = p(req, 'motivo_fechamento');
    const usuario = p(req, 'usuario', 'sistema');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `INSERT INTO chat_conversa_dono (conta_id, telefone, atendente, finalizada, finalizada_em, finalizada_por, motivo_fechamento, atribuido_em, atribuido_por)
       VALUES ($1,$2,'',true,NOW(),$3,$4,NOW(),$3)
       ON CONFLICT (conta_id, telefone) DO UPDATE
         SET finalizada=true, finalizada_em=NOW(), finalizada_por=$3, motivo_fechamento=$4`,
      [conta_id, telefone, usuario, motivo]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-conversa-finalizar', conversaFinalizar);

  // === chat-conversa-reabrir ===
  const conversaReabrir = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `UPDATE chat_conversa_dono SET finalizada=false, finalizada_em=NULL, motivo_fechamento=NULL
       WHERE conta_id=$1 AND telefone=$2`,
      [conta_id, telefone]
    );
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
  const triagemAtivar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    const config_codigo = p(req, 'config_codigo', 'default');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `INSERT INTO chat_triagem_sessoes (conta_id, telefone, config_codigo, passo_atual, status, iniciado_em, atualizado_em)
       VALUES ($1,$2,$3,0,'ativa',NOW(),NOW())
       ON CONFLICT (conta_id, telefone) DO UPDATE SET status='ativa', passo_atual=0, config_codigo=$3, atualizado_em=NOW()`,
      [conta_id, telefone, config_codigo]
    );
    return { ok: true };
  });
  fastify.post('/webhook/chat-triagem-ativar-conversa', triagemAtivar);

  const triagemDesativar = async (req, reply) => withDb(reply, async () => {
    const conta_id = p(req, 'conta_id');
    const telefone = p(req, 'telefone');
    if (!conta_id || !telefone) return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    await query(
      `UPDATE chat_triagem_sessoes SET status='encerrada', atualizado_em=NOW() WHERE conta_id=$1 AND telefone=$2`,
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

  // === chat-fila-toggle ===
  // Liga/desliga a chavinha "na_fila" de um atendente (fila.html e chat.html)
  const filaToggle = async (req, reply) => withDb(reply, async () => {
    const b = req.body || {};
    const usuario = String(b.usuario || '').toLowerCase().trim();
    if (!usuario) return reply.code(400).send({ ok: false, erro: 'usuario obrigatório' });
    const na_fila = b.na_fila === true || b.na_fila === 'true' || b.na_fila === 1;
    const r = await query(
      `UPDATE chat_atendentes SET na_fila=$2 WHERE LOWER(usuario)=LOWER($1) RETURNING usuario, na_fila`,
      [usuario, na_fila]
    );
    if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'usuario não encontrado' });
    return { ok: true, usuario: r.rows[0].usuario, na_fila: r.rows[0].na_fila };
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
    const rows = await query(
      `SELECT LOWER(usuario) AS usuario, COALESCE(nome,usuario) AS nome,
              COALESCE(foto_url,'') AS foto_url, COALESCE(na_fila,false) AS na_fila
       FROM chat_atendentes
       WHERE COALESCE(ativo,true)=true
         AND LOWER(COALESCE(papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
         AND LOWER(usuario) <> 'admin'
       ORDER BY usuario`
    );
    const inFila = rows.rows.filter(a => a.na_fila === true);
    const foraFila = rows.rows.filter(a => a.na_fila !== true);
    const ultimo = String(c.ultimo_atribuido || '').toLowerCase();
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
      in_fila: inFila.map(a => ({ usuario: a.usuario, nome: a.nome, foto_url: a.foto_url })),
      fora_fila: foraFila.map(a => ({ usuario: a.usuario, nome: a.nome, foto_url: a.foto_url })),
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
         AND COALESCE(a.na_fila,false)=true
         AND LOWER(COALESCE(a.papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
         AND LOWER(a.usuario) <> 'admin'
       ORDER BY backlog ASC, ultima_em ASC NULLS FIRST, a.usuario ASC
       LIMIT 1`
    );
    if (!rows.rows.length) return { ok: false, sem_fila: true, erro: 'nenhum consultor na fila' };
    const prox = rows.rows[0];
    await query(`UPDATE chat_fila_config SET ultimo_atribuido=$1, atualizado_em=NOW()`, [prox.usuario]);
    return {
      ok: true,
      conta_id, telefone,
      usuario_escolhido: prox.usuario,
      nome_escolhido: prox.nome,
      backlog_atual: prox.backlog,
    };
  });
  fastify.post('/webhook/chat-fila-proximo', filaProximo);

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
