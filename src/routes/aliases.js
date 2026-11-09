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
  const contasList = async (req, reply) => withDb(reply, async () => {
    const sql = config.contaFixa
      ? `SELECT codigo, nome, tipo, status, config FROM chat_contas WHERE codigo=$1`
      : `SELECT codigo, nome, tipo, status, config FROM chat_contas ORDER BY nome`;
    const r = await query(sql, config.contaFixa ? [config.contaFixa] : []);
    return { ok: true, contas: r.rows };
  });
  fastify.get('/webhook/chat-contas-list', contasList);
  fastify.post('/webhook/chat-contas-list', contasList);

  // === chat-atendentes-list ===
  const atendentesList = async (req, reply) => withDb(reply, async () => {
    const r = await query(
      `SELECT usuario, nome, papel, ativo, contas_permitidas, foto_url, na_fila, ultimo_ping
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
  const retornoList = async (req, reply) => withDb(reply, async () => {
    const usuario = p(req, 'usuario');
    const sql = usuario
      ? `SELECT * FROM chat_retornos_agendados WHERE LOWER(atendente)=LOWER($1) AND status='pendente' ORDER BY agendado_para`
      : `SELECT * FROM chat_retornos_agendados WHERE status='pendente' ORDER BY agendado_para`;
    const r = await query(sql, usuario ? [usuario] : []).catch(() => ({ rows: [] }));
    return { ok: true, retornos: r.rows };
  });
  fastify.get('/webhook/chat-retorno-list', retornoList);
  fastify.post('/webhook/chat-retorno-list', retornoList);

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

  // === chat-permissoes-list ===
  const permissoesList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT * FROM chat_permissoes_config LIMIT 1`).catch(() => ({ rows: [] }));
    const features = r.rows[0]?.features || {};
    return { ok: true, features };
  });
  fastify.get('/webhook/chat-permissoes-list', permissoesList);
  fastify.post('/webhook/chat-permissoes-list', permissoesList);

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
  const mensagens = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id'));
    const telefone = p(req, 'telefone');
    const limit = parseInt(p(req, 'limit', '200')) || 200;
    if (!conta_id || !telefone) return { ok: true, mensagens: [] };
    const r = await query(
      `SELECT id, codigo, conta_id, telefone, nome_contato, direcao, tipo, texto,
              midia_url, midia_mimetype, timestamp, status, external_id, atendente,
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
  const mensagensDelta = async (req, reply) => withDb(reply, async () => {
    const conta_id = forceConta(p(req, 'conta_id'));
    const telefone = p(req, 'telefone');
    const since = p(req, 'since');
    if (!conta_id || !telefone) return { ok: true, mensagens: [] };
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 60000);
    const r = await query(
      `SELECT id, codigo, conta_id, telefone, nome_contato, direcao, tipo, texto,
              midia_url, midia_mimetype, timestamp, status, external_id, atendente,
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
    return {
      ok: true,
      token: `session-${u.usuario}-${Date.now()}`,
      usuario: u.usuario,
      nome: u.nome,
      papel: u.papel,
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
}
