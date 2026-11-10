// Aliases /webhook/chat-* pra interceptar antes do proxy pro n8n
// Cada rota aqui substitui 1 workflow n8n equivalente, direto no pg pool (muito mais rápido)
import { query } from '../services/db.js';
import { hasDb, config } from '../config.js';
import { handleDisparoCriar } from './disparos.js';

function p(req, name, def = '') {
  const v = (req.body && req.body[name]) ?? req.query?.[name];
  if (v == null || v === '') return def;
  return String(v);
}

// Força conta_id se CONTA_FIXA setada (modo instância dedicada)
function forceConta(contaIdReq) {
  return config.contaFixa || contaIdReq || '';
}

// Splita conversa_id no formato "<conta_id>_<telefone>".
// conta_id pode conter underscores (meta_123456), telefone é só dígitos no final.
// Então quebra no ULTIMO underscore.
function splitConversaId(req) {
  const convId = p(req, 'conversa_id');
  if (!convId) return { conta_id: null, telefone: null };
  const idx = convId.lastIndexOf('_');
  if (idx < 0) return { conta_id: null, telefone: null };
  return { conta_id: convId.substring(0, idx), telefone: convId.substring(idx + 1) };
}

async function withDb(reply, fn) {
  if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
  try { return await fn(); }
  catch (err) { reply.code(500); return { ok: false, erro: err.message }; }
}

export default async function aliasRoutes(fastify) {
  // === chat-ping ===
  const ping = async (req, reply) => {
    return withDb(reply, async () => {
      const usuario = p(req, 'usuario');
      if (usuario) {
        await query(`UPDATE chat_atendentes SET ultimo_ping=NOW() WHERE LOWER(usuario)=LOWER($1)`, [usuario]).catch(() => {});
      }
      return { ok: true, pong: Date.now() };
    });
  };
  fastify.get('/webhook/chat-ping', ping);
  fastify.post('/webhook/chat-ping', ping);

  // === chat-link-versao-get ===
  // Retorna link forçado (empurrão de atualização). Vazio = sem empurrão.
  const linkVersaoGet = async (req, reply) => withDb(reply, async () => {
    const r = await query(
      `SELECT codigo, link, mensagem, atualizado_em FROM chat_link_versao ORDER BY atualizado_em DESC NULLS LAST LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const row = r.rows[0] || {};
    return { ok: true, link: row.link || '', mensagem: row.mensagem || '', codigo: row.codigo || '' };
  });
  fastify.get('/webhook/chat-link-versao-get', linkVersaoGet);
  fastify.post('/webhook/chat-link-versao-get', linkVersaoGet);

  // === chat-contas-list ===
  // Se CONTA_FIXA setada, retorna só essa conta (modo dedicado)
  // Retorna codigo E id (alias) porque o front usa c.id
  const contasList = async (req, reply) => withDb(reply, async () => {
    const sql = config.contaFixa
      ? `SELECT codigo, codigo AS id, nome, tipo, status, config FROM chat_contas WHERE codigo=$1`
      : `SELECT codigo, codigo AS id, nome, tipo, status, config FROM chat_contas ORDER BY nome`;
    const r = await query(sql, config.contaFixa ? [config.contaFixa] : []);
    return { ok: true, contas: r.rows };
  });
  fastify.get('/webhook/chat-contas-list', contasList);
  fastify.post('/webhook/chat-contas-list', contasList);

  // === chat-atendentes-list ===
  // Retorna papel E role (alias) porque o front usa a.role mas a coluna é papel
  const atendentesList = async (req, reply) => withDb(reply, async () => {
    const r = await query(
      `SELECT usuario, nome, papel, papel AS role, ativo, contas_permitidas, foto_url, na_fila, ultimo_ping
       FROM chat_atendentes ORDER BY nome, usuario`
    );
    return { ok: true, atendentes: r.rows };
  });
  fastify.get('/webhook/chat-atendentes-list', atendentesList);
  fastify.post('/webhook/chat-atendentes-list', atendentesList);

  // === chat-motivos-list ===
  const motivosList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT codigo, nome, tipo, cor, ordem FROM chat_motivos_fechamento ORDER BY ordem, nome`).catch(() => ({ rows: [] }));
    return { ok: true, motivos: r.rows };
  });
  fastify.get('/webhook/chat-motivos-list', motivosList);
  fastify.post('/webhook/chat-motivos-list', motivosList);

  // === chat-etiquetas-list ===
  const etiquetasList = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id'));
    const sql = conta_id && conta_id !== '__all__'
      ? `SELECT DISTINCT etiqueta FROM chat_conversa_etiquetas WHERE conta_id=$1 ORDER BY etiqueta`
      : `SELECT DISTINCT etiqueta FROM chat_conversa_etiquetas ORDER BY etiqueta`;
    const r = await query(sql, conta_id && conta_id !== '__all__' ? [conta_id] : []);
    return { ok: true, etiquetas: r.rows.map(x => x.etiqueta) };
  });
  fastify.get('/webhook/chat-etiquetas-list', etiquetasList);
  fastify.post('/webhook/chat-etiquetas-list', etiquetasList);

  // === chat-respostas-list ===
  // Filtra: usuário SUPER (contas_permitidas=['*']) vê tudo;
  // demais veem só as próprias + de quem compartilha conta (interseção de contas_permitidas).
  const respostasList = async (req, reply) => withDb(reply, async () => {
    const usuario = p(req, 'usuario').toLowerCase();
    if (!usuario) {
      const r = await query(`SELECT * FROM chat_respostas_rapidas WHERE ativo=true ORDER BY atalho`).catch(() => ({ rows: [] }));
      return { ok: true, respostas: r.rows };
    }
    const meRes = await query(
      `SELECT papel, contas_permitidas FROM chat_atendentes WHERE LOWER(usuario)=LOWER($1) LIMIT 1`,
      [usuario]
    );
    const me = meRes.rows[0];
    const minhasContas = Array.isArray(me?.contas_permitidas) ? me.contas_permitidas : [];
    const isSuper = minhasContas.includes('*');
    if (isSuper) {
      const r = await query(`SELECT * FROM chat_respostas_rapidas WHERE ativo=true ORDER BY atalho`);
      return { ok: true, respostas: r.rows };
    }
    const r = await query(
      `SELECT r.* FROM chat_respostas_rapidas r
       LEFT JOIN chat_atendentes a ON LOWER(a.usuario)=LOWER(r.atendente)
       WHERE r.ativo=true
         AND (
           LOWER(r.atendente)=LOWER($1)
           OR '*' = ANY(COALESCE(a.contas_permitidas, ARRAY[]::text[]))
           OR a.contas_permitidas && $2::text[]
         )
       ORDER BY r.atalho`,
      [usuario, minhasContas]
    );
    return { ok: true, respostas: r.rows };
  });
  fastify.get('/webhook/chat-respostas-list', respostasList);
  fastify.post('/webhook/chat-respostas-list', respostasList);

  // === chat-retorno-list ===
  // Retorna com nomes que o front espera: codigo, quando, observacao, venceu.
  // Autodetect: tabela pode ter colunas 'quando'/'observacao' OU 'agendado_para'/'nota'.
  let _retornosCols = null;
  async function detectarColsRetornos() {
    if (_retornosCols) return _retornosCols;
    const r = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='chat_retornos_agendados'
    `).catch(() => ({ rows: [] }));
    const cols = new Set(r.rows.map(x => x.column_name));
    _retornosCols = {
      data: cols.has('quando') ? 'quando' : (cols.has('agendado_para') ? 'agendado_para' : null),
      nota: cols.has('observacao') ? 'observacao' : (cols.has('nota') ? 'nota' : null),
      codigo: cols.has('codigo'),
    };
    return _retornosCols;
  }
  const retornoList = async (req, reply) => withDb(reply, async () => {
    const usuario = p(req, 'usuario');
    const sc = await detectarColsRetornos();
    if (!sc.data) return { ok: true, retornos: [] };
    const codExpr = sc.codigo ? `COALESCE(codigo, id::text)` : `id::text`;
    const notaExpr = sc.nota ? sc.nota : `''`;
    const sql = usuario
      ? `SELECT ${codExpr} AS codigo, conta_id, telefone, atendente,
               ${sc.data} AS quando, ${notaExpr} AS observacao,
               (${sc.data} < NOW()) AS venceu, status
         FROM chat_retornos_agendados
         WHERE (LOWER(COALESCE(atendente,''))=LOWER($1) OR COALESCE(atendente,'')='')
           AND status='pendente'
         ORDER BY ${sc.data}`
      : `SELECT ${codExpr} AS codigo, conta_id, telefone, atendente,
               ${sc.data} AS quando, ${notaExpr} AS observacao,
               (${sc.data} < NOW()) AS venceu, status
         FROM chat_retornos_agendados
         WHERE status='pendente'
         ORDER BY ${sc.data}`;
    const r = await query(sql, usuario ? [usuario] : []).catch(() => ({ rows: [] }));
    return { ok: true, retornos: r.rows };
  });
  fastify.get('/webhook/chat-retorno-list', retornoList);
  fastify.post('/webhook/chat-retorno-list', retornoList);

  // DEBUG: últimos 20 retornos (sem filtro) + schema
  fastify.get('/webhook/chat-retorno-debug', async () => {
    try {
      const cols = await query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='chat_retornos_agendados' ORDER BY ordinal_position
      `).catch(() => ({ rows: [] }));
      const total = await query(`SELECT COUNT(*)::int AS t FROM chat_retornos_agendados`).catch(() => ({ rows: [{t:0}] }));
      const ultimos = await query(`SELECT * FROM chat_retornos_agendados ORDER BY id DESC LIMIT 20`).catch(err => ({ rows: [], err: err.message }));
      return { ok: true, schema: cols.rows, total: total.rows[0]?.t, ultimos: ultimos.rows, erro: ultimos.err };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  });

  // === chat-triagem-ativas ===
  const triagemAtivas = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT conta_id, telefone, status, passo_atual, atualizado_em FROM chat_triagem_sessoes WHERE status='ativa' LIMIT 1000`).catch(() => ({ rows: [] }));
    return { ok: true, sessoes: r.rows };
  });
  fastify.get('/webhook/chat-triagem-ativas', triagemAtivas);
  fastify.post('/webhook/chat-triagem-ativas', triagemAtivas);

  // === chat-triagem-config-list ===
  const triagemConfigList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT * FROM chat_triagem_config ORDER BY codigo`).catch(() => ({ rows: [] }));
    return { ok: true, configs: r.rows };
  });
  fastify.get('/webhook/chat-triagem-config-list', triagemConfigList);
  fastify.post('/webhook/chat-triagem-config-list', triagemConfigList);

  // === chat-manual-nos-list ===
  const manualNosList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT * FROM chat_manual_nos ORDER BY ordem, titulo`).catch(() => ({ rows: [] }));
    return { ok: true, nos: r.rows };
  });
  fastify.get('/webhook/chat-manual-nos-list', manualNosList);
  fastify.post('/webhook/chat-manual-nos-list', manualNosList);

  // === chat-manual-estado-get ===
  const manualEstadoGet = async (req, reply) => withDb(reply, async () => {
    const usuario = p(req, 'usuario');
    const r = await query(`SELECT * FROM chat_manual_estado WHERE LOWER(usuario)=LOWER($1) LIMIT 1`, [usuario]).catch(() => ({ rows: [] }));
    return { ok: true, estado: r.rows[0] || null };
  });
  fastify.get('/webhook/chat-manual-estado-get', manualEstadoGet);
  fastify.post('/webhook/chat-manual-estado-get', manualEstadoGet);

  // === chat-permissoes-list/save ===
  // Schema: chat_permissoes_config(chave PK, valor jsonb) — chave='features_user' = global
  //         chat_user_permissoes(usuario PK, permissoes jsonb) — override por usuario
  let _permTablesOk = false;
  async function garantirTabelasPerm() {
    if (_permTablesOk) return;
    await query(`
      CREATE TABLE IF NOT EXISTS chat_permissoes_config (
        chave TEXT PRIMARY KEY,
        valor JSONB DEFAULT '{}'::jsonb,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await query(`
      CREATE TABLE IF NOT EXISTS chat_user_permissoes (
        usuario TEXT PRIMARY KEY,
        permissoes JSONB DEFAULT '{}'::jsonb,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    _permTablesOk = true;
  }

  function parseJson(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (_) { return null; }
  }

  const permissoesList = async (req, reply) => withDb(reply, async () => {
    await garantirTabelasPerm();
    const usuario = String(req.query?.usuario || req.body?.usuario || '').toLowerCase().trim();
    const g = await query(`SELECT valor FROM chat_permissoes_config WHERE chave='features_user' LIMIT 1`).catch(() => ({ rows: [] }));
    const global_ = parseJson(g.rows[0]?.valor) || {};
    let override = null;
    if (usuario) {
      const u = await query(`SELECT permissoes FROM chat_user_permissoes WHERE LOWER(usuario)=LOWER($1) LIMIT 1`, [usuario]).catch(() => ({ rows: [] }));
      override = parseJson(u.rows[0]?.permissoes);
    }
    const effective = override ? { ...global_, ...override } : global_;
    return { ok: true, permissoes: effective, global: global_, override };
  });
  fastify.get('/webhook/chat-permissoes-list', permissoesList);
  fastify.post('/webhook/chat-permissoes-list', permissoesList);

  const permissoesSave = async (req, reply) => withDb(reply, async () => {
    await garantirTabelasPerm();
    const b = req.body || {};
    const perms = b.permissoes && typeof b.permissoes === 'object' ? b.permissoes : null;
    if (!perms && b._reset !== true) {
      return reply.code(400).send({ ok: false, erro: 'permissoes obrigatorio (objeto)' });
    }
    const usuario = String(b.usuario || '').toLowerCase().trim();
    // Sanitiza: so booleans + keys alfanumericas
    const limpo = {};
    if (perms) {
      for (const k of Object.keys(perms)) {
        if (/^[a-z0-9_]+$/i.test(k)) limpo[k] = !!perms[k];
      }
    }
    const jsonStr = JSON.stringify(limpo);
    const reset = b._reset === true;

    if (usuario && usuario !== 'default') {
      if (reset) {
        await query(`DELETE FROM chat_user_permissoes WHERE LOWER(usuario)=LOWER($1)`, [usuario]);
      } else {
        await query(
          `INSERT INTO chat_user_permissoes (usuario, permissoes, atualizado_em)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (usuario) DO UPDATE SET permissoes=EXCLUDED.permissoes, atualizado_em=NOW()`,
          [usuario, jsonStr]
        );
      }
    } else {
      await query(
        `INSERT INTO chat_permissoes_config (chave, valor, atualizado_em)
         VALUES ('features_user', $1::jsonb, NOW())
         ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor, atualizado_em=NOW()`,
        [jsonStr]
      );
    }
    return { ok: true, escopo: usuario && usuario !== 'default' ? 'user' : 'global', reset };
  });
  fastify.post('/webhook/chat-permissoes-save', permissoesSave);

  // === chat-stickers-list ===
  const stickersList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT * FROM chat_stickers ORDER BY favorito DESC, usos DESC, id DESC LIMIT 200`).catch(() => ({ rows: [] }));
    return { ok: true, stickers: r.rows };
  });
  fastify.get('/webhook/chat-stickers-list', stickersList);
  fastify.post('/webhook/chat-stickers-list', stickersList);

  // === chat-eventos-list ===
  const eventosList = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id'));
    const telefone = p(req, 'telefone');
    if (!conta_id || !telefone) return { ok: true, eventos: [] };
    const r = await query(
      `SELECT * FROM chat_conversa_eventos WHERE conta_id=$1 AND telefone=$2 ORDER BY criado_em DESC LIMIT 200`,
      [conta_id, telefone]
    ).catch(() => ({ rows: [] }));
    return { ok: true, eventos: r.rows };
  });
  fastify.get('/webhook/chat-eventos-list', eventosList);
  fastify.post('/webhook/chat-eventos-list', eventosList);

  // === chat-tarefas-get ===
  const tarefasGet = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id'));
    const telefone = p(req, 'telefone');
    if (!conta_id || !telefone) return { ok: true, tarefas: [] };
    const r = await query(
      `SELECT * FROM chat_tarefas_conversa WHERE conta_id=$1 AND telefone=$2 ORDER BY id`,
      [conta_id, telefone]
    ).catch(() => ({ rows: [] }));
    return { ok: true, tarefas: r.rows };
  });
  fastify.get('/webhook/chat-tarefas-get', tarefasGet);
  fastify.post('/webhook/chat-tarefas-get', tarefasGet);

  // === chat-mensagens ===
  // Aceita conta_id+telefone OU conversa_id no formato "<conta_id>_<telefone>"
  // (chat.html manda ?conversa_id=meta_123_5511999... — splitConversaId no topo)
  const mensagens = async (req, reply) => withDb(reply, async () => {
    let conta_id = p(req, 'conta_id');
    let telefone = p(req, 'telefone');
    if (!conta_id || !telefone) {
      const parsed = splitConversaId(req);
      conta_id = parsed.conta_id;
      telefone = parsed.telefone;
    }
    conta_id = forceConta(conta_id);
    const limit = parseInt(p(req, 'limit', '200')) || 200;
    if (!conta_id || !telefone) return { ok: true, mensagens: [] };
    const r = await query(
      `SELECT id, codigo, conta_id, telefone, nome_contato, direcao, tipo, texto,
              midia_url, NULL::text AS midia_mimetype, timestamp, status, external_id, atendente,
              reply_to_id, reply_to_texto
       FROM chat_mensagens
       WHERE conta_id=$1 AND telefone=$2
       ORDER BY timestamp DESC
       LIMIT $3`,
      [conta_id, telefone, limit]
    );
    return { ok: true, mensagens: r.rows.reverse() };
  });
  fastify.get('/webhook/chat-mensagens', mensagens);
  fastify.post('/webhook/chat-mensagens', mensagens);

  // === chat-mensagens-delta ===
  // Aceita conta_id+telefone OU conversa_id "<conta_id>_<telefone>", e desde_ts OU since
  const mensagensDelta = async (req, reply) => withDb(reply, async () => {
    let conta_id = p(req, 'conta_id');
    let telefone = p(req, 'telefone');
    if (!conta_id || !telefone) {
      const parsed = splitConversaId(req);
      conta_id = parsed.conta_id;
      telefone = parsed.telefone;
    }
    conta_id = forceConta(conta_id);
    const since = p(req, 'since') || p(req, 'desde_ts');
    if (!conta_id || !telefone) return { ok: true, mensagens: [] };
    // Date inválida → fallback pra 60s atrás (evita erro de cast no PG)
    let sinceDate = since ? new Date(since) : new Date(Date.now() - 60000);
    if (isNaN(sinceDate.getTime())) sinceDate = new Date(Date.now() - 60000);
    const r = await query(
      `SELECT id, codigo, conta_id, telefone, nome_contato, direcao, tipo, texto,
              midia_url, NULL::text AS midia_mimetype, timestamp, status, external_id, atendente,
              reply_to_id, reply_to_texto
       FROM chat_mensagens
       WHERE conta_id=$1 AND telefone=$2 AND timestamp > $3
       ORDER BY timestamp ASC LIMIT 200`,
      [conta_id, telefone, sinceDate]
    );
    return { ok: true, mensagens: r.rows };
  });
  fastify.get('/webhook/chat-mensagens-delta', mensagensDelta);
  fastify.post('/webhook/chat-mensagens-delta', mensagensDelta);

  // === chat-login (mesma logica do /api/auth/login mas no webhook antigo) ===
  const chatLogin = async (req, reply) => withDb(reply, async () => {
    const usuario = p(req, 'usuario').trim();
    const senha = p(req, 'senha');
    if (!usuario || !senha) return { ok: false, erro: 'usuario e senha obrigatórios' };
    const r = await query(
      `SELECT usuario, nome, senha, papel, ativo, contas_permitidas, foto_url
       FROM chat_atendentes WHERE LOWER(usuario)=LOWER($1) LIMIT 1`,
      [usuario]
    );
    if (!r.rows.length) return { ok: false, erro: 'Usuário ou senha incorretos' };
    const u = r.rows[0];
    if (u.senha !== senha) return { ok: false, erro: 'Usuário ou senha incorretos' };
    if (u.ativo === false) return { ok: false, erro: 'Usuário desativado' };
    // Modo instância dedicada: força contas_permitidas pra conta fixa
    const contasPermitidas = config.contaFixa ? [config.contaFixa] : u.contas_permitidas;
    // Normaliza papel pro vocabulário do front: USER/ADM/SUPER
    const papelRaw = String(u.papel || 'USER').toUpperCase();
    const papel = (papelRaw === 'CONSULTOR' || papelRaw === 'CONSULTANT' || papelRaw === 'AGENT')
      ? 'USER'
      : (papelRaw === 'ADMIN' ? 'ADM' : papelRaw);
    return {
      ok: true,
      token: `session-${u.usuario}-${Date.now()}`,
      usuario: u.usuario,
      nome: u.nome,
      papel,
      role: papel,  // alias pro front que usa a.role
      contas_permitidas: contasPermitidas,
      foto_url: u.foto_url,
    };
  });
  fastify.post('/webhook/chat-login', chatLogin);
  fastify.post('/webhook/chat-auth', chatLogin);  // login.html chama 'chat-auth', não 'chat-login'

  // === chat-conversas-finalizadas (lista de finalizadas paginada) ===
  const conversasFinalizadas = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id', '__all__')) || '__all__';
    const limit = parseInt(p(req, 'limit', '100')) || 100;
    const offset = parseInt(p(req, 'offset', '0')) || 0;
    const r = await query(
      `SELECT cd.conta_id, cd.telefone, cd.atendente, cd.finalizada_em, cd.motivo_fechamento,
              mf.nome AS motivo_nome, mf.tipo AS motivo_tipo, mf.cor AS motivo_cor
       FROM chat_conversa_dono cd
       LEFT JOIN chat_motivos_fechamento mf ON mf.codigo = cd.motivo_fechamento
       WHERE cd.finalizada = true
         AND ($1 = '__all__' OR cd.conta_id = $1)
       ORDER BY cd.finalizada_em DESC
       LIMIT $2 OFFSET $3`,
      [conta_id, limit, offset]
    );
    return { ok: true, conversas: r.rows };
  });
  fastify.get('/webhook/chat-conversas-finalizadas', conversasFinalizadas);
  fastify.post('/webhook/chat-conversas-finalizadas', conversasFinalizadas);

  // === chat-buscar-mensagens (busca por texto dentro das msgs) ===
  const buscarMensagens = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id', '__all__')) || '__all__';
    const termo = p(req, 'termo').trim();
    const limit = parseInt(p(req, 'limit', '50')) || 50;
    if (!termo || termo.length < 2) return { ok: true, resultados: [] };
    const r = await query(
      `SELECT conta_id, telefone, nome_contato, texto, timestamp, direcao, atendente
       FROM chat_mensagens
       WHERE ($1 = '__all__' OR conta_id = $1)
         AND texto ILIKE $2
       ORDER BY timestamp DESC
       LIMIT $3`,
      [conta_id, '%' + termo + '%', limit]
    );
    return { ok: true, resultados: r.rows };
  });
  fastify.get('/webhook/chat-buscar-mensagens', buscarMensagens);
  fastify.post('/webhook/chat-buscar-mensagens', buscarMensagens);

  // === chat-disparos-criar (criar campanha pelo painel de disparos.html) ===
  // Vai pro backend novo em vez do n8n → zero duplicação via pg-boss worker
  fastify.post('/webhook/chat-disparos-criar', handleDisparoCriar);

  // === chat-disparos-list (lista campanhas) ===
  // Recalcula status/contadores antes de retornar — garante dados frescos.
  const disparosList = async (req, reply) => {
    try {
      // Recalcula primeiro (nao-bloqueante — se falhar segue a vida)
      try {
        await query(`
          WITH stats AS (
            SELECT campanha_id,
                   COUNT(*) FILTER (WHERE status='enviado') AS e,
                   COUNT(*) FILTER (WHERE status IN ('erro','cancelado')) AS f
            FROM chat_disparos_msgs
            WHERE campanha_id IN (SELECT codigo FROM chat_disparos WHERE status IN ('em_andamento','agendado'))
            GROUP BY campanha_id
          )
          UPDATE chat_disparos c
          SET enviadas = s.e, falharam = s.f, atualizado_em = NOW(),
              status = CASE WHEN s.e + s.f >= c.total_msgs THEN 'concluido' ELSE 'em_andamento' END
          FROM stats s
          WHERE c.codigo = s.campanha_id AND c.status IN ('em_andamento','agendado')
        `);
      } catch (_) {}

      const conta_id = req.query?.conta_id || req.body?.conta_id;
      const sql = conta_id
        ? `SELECT codigo, nome, conta_id, total_msgs, enviadas, falharam, status, criado_em, atendente, dono, template_name, template_language
           FROM chat_disparos WHERE conta_id = $1 ORDER BY criado_em DESC LIMIT 100`
        : `SELECT codigo, nome, conta_id, total_msgs, enviadas, falharam, status, criado_em, atendente, dono, template_name, template_language
           FROM chat_disparos ORDER BY criado_em DESC LIMIT 100`;
      const res = await query(sql, conta_id ? [conta_id] : []);
      return { ok: true, campanhas: res.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  };
  fastify.get('/webhook/chat-disparos-list', disparosList);
  fastify.post('/webhook/chat-disparos-list', disparosList);
}
