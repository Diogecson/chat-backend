// Aliases /webhook/chat-* pra interceptar antes do proxy pro n8n
// Cada rota aqui substitui 1 workflow n8n equivalente, direto no pg pool (muito mais rápido)
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

function p(req, name, def = '') {
  const v = (req.body && req.body[name]) ?? req.query?.[name];
  if (v == null || v === '') return def;
  return String(v);
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
  const linkVersaoGet = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT versao, forcar_reload, atualizado_em FROM chat_link_versao ORDER BY id DESC LIMIT 1`).catch(() => ({ rows: [] }));
    return { ok: true, ...(r.rows[0] || { versao: '1.0.0' }) };
  });
  fastify.get('/webhook/chat-link-versao-get', linkVersaoGet);
  fastify.post('/webhook/chat-link-versao-get', linkVersaoGet);

  // === chat-contas-list ===
  const contasList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT codigo, nome, tipo, status, config FROM chat_contas ORDER BY nome`);
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
    const conta_id = p(req, 'conta_id');
    const sql = conta_id && conta_id !== '__all__'
      ? `SELECT DISTINCT etiqueta FROM chat_conversa_etiquetas WHERE conta_id=$1 ORDER BY etiqueta`
      : `SELECT DISTINCT etiqueta FROM chat_conversa_etiquetas ORDER BY etiqueta`;
    const r = await query(sql, conta_id && conta_id !== '__all__' ? [conta_id] : []);
    return { ok: true, etiquetas: r.rows.map(x => x.etiqueta) };
  });
  fastify.get('/webhook/chat-etiquetas-list', etiquetasList);
  fastify.post('/webhook/chat-etiquetas-list', etiquetasList);

  // === chat-respostas-list ===
  const respostasList = async (req, reply) => withDb(reply, async () => {
    const r = await query(`SELECT * FROM chat_respostas_rapidas ORDER BY atalho`).catch(() => ({ rows: [] }));
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
    const conta_id = p(req, 'conta_id');
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
    const conta_id = p(req, 'conta_id');
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
    const conta_id = p(req, 'conta_id');
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
    const conta_id = p(req, 'conta_id');
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
}
