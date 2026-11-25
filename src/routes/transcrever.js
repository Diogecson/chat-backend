// chat-transcrever-msg: transcreve audio de msg usando Whisper (OpenAI)
// Le midia_url do banco (data:audio/...;base64,...), monta FormData
// e chama POST /v1/audio/transcriptions. Grava resultado em chat_mensagens.texto.
//
// Env obrigatorio: OPENAI_API_KEY (valor da chave sk-... da conta "GPT DG PAGO").
// O codigo nao fallback pro n8n: se chave faltar, erro claro no painel.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODELO = process.env.WHISPER_MODEL || 'whisper-1';

// Converte data:URL em {buffer, mimetype, ext}
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mimetype = match[1];
  const b64 = match[2];
  const buffer = Buffer.from(b64, 'base64');
  // Extensao usada no filename: Whisper precisa saber o tipo
  const extMap = {
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/webm': 'webm',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
  };
  const ext = extMap[mimetype] || 'ogg';
  return { buffer, mimetype, ext };
}

export default async function transcreverRoutes(fastify) {
  async function handle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    if (!OPENAI_API_KEY) {
      return reply.code(500).send({ ok: false, erro: 'OPENAI_API_KEY nao configurado no backend' });
    }

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

    // Converte data:URL em buffer
    let audio;
    if (msg.midia_url.startsWith('data:')) {
      audio = dataUrlToBuffer(msg.midia_url);
      if (!audio) return reply.code(400).send({ ok: false, erro: 'midia_url data: invalido' });
    } else {
      // URL http(s) — baixa
      try {
        const rr = await fetch(msg.midia_url);
        if (!rr.ok) return reply.code(502).send({ ok: false, erro: 'falha ao baixar midia: HTTP ' + rr.status });
        const ct = rr.headers.get('content-type') || 'audio/ogg';
        const buf = Buffer.from(await rr.arrayBuffer());
        const extMap2 = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/wav': 'wav' };
        const ext = extMap2[ct.split(';')[0].trim()] || 'ogg';
        audio = { buffer: buf, mimetype: ct, ext };
      } catch (err) {
        return reply.code(502).send({ ok: false, erro: 'falha download: ' + err.message });
      }
    }

    // Monta FormData pro Whisper
    const fd = new FormData();
    const blob = new Blob([audio.buffer], { type: audio.mimetype });
    fd.append('file', blob, `audio_${msg.id}.${audio.ext}`);
    fd.append('model', MODELO);
    fd.append('language', 'pt');
    fd.append('response_format', 'json');

    try {
      const rr = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: fd,
      });
      const data = await rr.json().catch(() => ({}));
      if (!rr.ok || data?.error) {
        const errMsg = data?.error?.message || `HTTP ${rr.status}`;
        console.error('[transcrever] openai erro:', errMsg, data);
        return reply.code(502).send({ ok: false, erro: 'openai: ' + errMsg });
      }
      const texto = String(data.text || '').trim();
      if (!texto) return reply.code(502).send({ ok: false, erro: 'transcricao vazia' });

      // Grava no banco pra cache na proxima vez
      await query(`UPDATE chat_mensagens SET texto=$1 WHERE id=$2`, [texto, msg.id]);
      console.log(`[transcrever] msg_id=${msg.id} ok chars=${texto.length}`);
      return { ok: true, texto };
    } catch (err) {
      console.error('[transcrever] fetch err:', err.message);
      return reply.code(502).send({ ok: false, erro: 'falha openai: ' + err.message });
    }
  }

  fastify.post('/webhook/chat-transcrever-msg', handle);
  fastify.post('/api/chat/transcrever-msg', handle);
}
