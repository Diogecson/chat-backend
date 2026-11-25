// chat-transcrever-msg: le a msg (tipo=audio) do banco, manda midia base64
// pro fluxo n8n `/webhook/chat-transcrever-whisper` que roda Whisper usando
// a credencial "GPT DG PAGO" (openAiApi id NK9ttQkECOReZ71h). Zero chave no backend.
//
// Resposta esperada do n8n: {ok:true, texto:"..."} ou {ok:false, erro:"..."}.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const N8N_UPSTREAM = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';
const TRANSCREVER_WEBHOOK = process.env.TRANSCREVER_WEBHOOK || `${N8N_UPSTREAM}/webhook/chat-transcrever-whisper`;

export default async function transcreverRoutes(fastify) {
  async function handle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });

    const b = req.body || {};
    const codigo = String(b.codigo || b.msg_id || '').trim();
    if (!codigo) return reply.code(400).send({ ok: false, erro: 'codigo obrigatorio' });

    // Busca a msg
    const idNum = /^\d+$/.test(codigo) ? Number(codigo) : null;
    const r = await query(
      `SELECT id, conta_id, telefone, tipo, texto, midia_url
       FROM chat_mensagens
       WHERE (${idNum !== null ? 'id=$1 OR ' : ''}codigo=$1)
       LIMIT 1`,
      [idNum !== null ? idNum : codigo]
    );
    if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'msg nao encontrada' });
    const msg = r.rows[0];
    if (msg.tipo !== 'audio') {
      return reply.code(400).send({ ok: false, erro: 'msg nao e audio (tipo=' + msg.tipo + ')' });
    }
    if (!msg.midia_url) {
      return reply.code(400).send({ ok: false, erro: 'msg sem midia_url no banco' });
    }

    // Se ja tem transcricao, devolve direto (idempotente)
    if (msg.texto && msg.texto.trim() && !msg.texto.startsWith('[audio')) {
      return { ok: true, texto: msg.texto, cache: true };
    }

    // Manda pro n8n que roda Whisper com GPT DG PAGO
    try {
      const rr = await fetch(TRANSCREVER_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codigo: msg.id,
          conta_id: msg.conta_id,
          telefone: msg.telefone,
          midia_url: msg.midia_url, // data:audio/...;base64,... ou http
        }),
      });
      const txt = await rr.text();
      let data;
      try { data = JSON.parse(txt); } catch (_) { data = { ok: false, erro: 'n8n nao-JSON: ' + txt.substring(0, 200) }; }
      if (!rr.ok || !data.ok) {
        return reply.code(502).send({ ok: false, erro: data?.erro || `n8n HTTP ${rr.status}` });
      }
      const texto = String(data.texto || data.text || '').trim();
      if (!texto) return reply.code(502).send({ ok: false, erro: 'n8n retornou transcricao vazia' });

      // Grava no banco pra cache
      await query(`UPDATE chat_mensagens SET texto=$1 WHERE id=$2`, [texto, msg.id]);
      console.log(`[transcrever] msg_id=${msg.id} ok chars=${texto.length}`);
      return { ok: true, texto };
    } catch (err) {
      console.error('[transcrever] fetch n8n err:', err.message);
      return reply.code(502).send({ ok: false, erro: 'falha n8n: ' + err.message });
    }
  }

  fastify.post('/webhook/chat-transcrever-msg', handle);
  fastify.post('/api/chat/transcrever-msg', handle);
}
