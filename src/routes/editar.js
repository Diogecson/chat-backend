// chat-editar-msg: EDIT INTERNO — atualiza chat_mensagens.texto no banco,
// marca editado_em e preserva texto_original na primeira edicao.
// Nao chama a Meta Cloud API (a API oficial nao permite editar outbound).
// Serve pra: histoico limpo no painel, treino da IA com texto correto,
// auditoria. O cliente continua vendo a msg antiga no WhatsApp dele.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

// Janela pra editar: 15 min (mesmo limite do WhatsApp Business app)
const JANELA_EDIT_MS = 15 * 60 * 1000;

let schemaEnsured = false;
export async function ensureEditSchema() {
  if (schemaEnsured) return;
  try {
    await query(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS editado_em TIMESTAMPTZ`);
    await query(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS texto_original TEXT`);
    schemaEnsured = true;
  } catch (err) {
    console.error('[editar] ensureEditSchema falhou:', err.message);
  }
}

export default async function editarRoutes(fastify) {
  async function handleEditar(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureEditSchema();

    const b = req.body || {};
    const conta_id = String(b.conta_id || '');
    const msg_id = String(b.msg_id || b.codigo || b.id || '');
    const texto_novo = String(b.texto_novo || b.texto || '').trim();
    const usuario = String(b.usuario || 'sistema');

    if (!conta_id || !msg_id || !texto_novo) {
      return reply.code(400).send({ ok: false, erro: 'conta_id, msg_id e texto_novo obrigatorios' });
    }
    if (texto_novo.length > 4096) {
      return reply.code(400).send({ ok: false, erro: 'texto > 4096 chars' });
    }

    // Busca a mensagem: aceita id numerico OU codigo
    const idNum = /^\d+$/.test(msg_id) ? Number(msg_id) : null;
    const msgRes = await query(
      `SELECT id, codigo, conta_id, telefone, direcao, tipo, texto, timestamp, external_id, atendente, editado_em
       FROM chat_mensagens
       WHERE conta_id=$1 AND (${idNum !== null ? 'id=$2 OR ' : ''}codigo=$2)
       LIMIT 1`,
      [conta_id, idNum !== null ? idNum : msg_id]
    );
    if (!msgRes.rows.length) {
      return reply.code(404).send({ ok: false, erro: 'mensagem nao encontrada' });
    }
    const msg = msgRes.rows[0];

    if (msg.direcao !== 'out') {
      return reply.code(400).send({ ok: false, erro: 'so da pra editar msg enviada por voce (out)' });
    }
    if (msg.tipo !== 'text') {
      return reply.code(400).send({ ok: false, erro: 'so da pra editar msg de texto' });
    }
    const enviado_em = new Date(msg.timestamp).getTime();
    const agora = Date.now();
    if (agora - enviado_em > JANELA_EDIT_MS) {
      return reply.code(400).send({ ok: false, erro: 'passou da janela de 15min pra editar' });
    }
    if (String(msg.texto || '').trim() === texto_novo) {
      return reply.code(400).send({ ok: false, erro: 'texto igual ao atual' });
    }

    // Atualiza banco: texto_original so na primeira edicao
    const texto_original_novo = msg.editado_em ? null : msg.texto;
    const upd = await query(
      `UPDATE chat_mensagens
       SET texto=$1,
           editado_em=NOW(),
           texto_original=COALESCE(texto_original, $2)
       WHERE id=$3
       RETURNING id, codigo, texto, timestamp, editado_em, texto_original, atendente`,
      [texto_novo, texto_original_novo, msg.id]
    );
    const row = upd.rows[0];
    console.log(`[editar] usuario=${usuario} msg_id=${msg.id} edit_interno ok`);
    return { ok: true, mensagem: row, edit_interno: true };
  }

  fastify.post('/webhook/chat-editar-msg', handleEditar);
  fastify.post('/api/chat/editar-msg', handleEditar);
}
