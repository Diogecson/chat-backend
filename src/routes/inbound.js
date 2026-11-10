// /webhook/chat-inbound-meta — recebe webhooks da Meta WhatsApp Cloud API
// GET  = verify token (handshake inicial com a Meta)
// POST = mensagens novas + atualizacoes de status
// Resposta 200 OBRIGATORIA e RAPIDA (Meta re-envia se timeout). Processamento
// pesado (download de midia) roda APOS a resposta (fire-and-forget).
import { query } from '../services/db.js';
import { hasDb, config } from '../config.js';

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'unifecaf';

function parseMensagens(body) {
  const rows = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const e of entries) {
    const changes = Array.isArray(e.changes) ? e.changes : [];
    for (const ch of changes) {
      const v = ch.value || {};
      const phone_id = (v.metadata && v.metadata.phone_number_id) || '';
      const conta_id = 'meta_' + String(phone_id).replace(/\D/g, '');
      const nomeMap = {};
      for (const c of (Array.isArray(v.contacts) ? v.contacts : [])) {
        nomeMap[c.wa_id] = (c.profile && c.profile.name) || '';
      }
      for (const m of (Array.isArray(v.messages) ? v.messages : [])) {
        const telefone = String(m.from || '').replace(/\D/g, '');
        if (!telefone) continue;
        let tipo = 'text', texto = '', midia = '';
        if (m.type === 'text') { texto = m.text?.body || ''; }
        else if (m.type === 'image') { tipo = 'image'; texto = m.image?.caption || ''; midia = m.image?.id || ''; }
        else if (m.type === 'audio') { tipo = 'audio'; midia = m.audio?.id || ''; }
        else if (m.type === 'video') { tipo = 'video'; texto = m.video?.caption || ''; midia = m.video?.id || ''; }
        else if (m.type === 'sticker') { tipo = 'sticker'; midia = m.sticker?.id || ''; }
        else if (m.type === 'document') { tipo = 'document'; texto = m.document?.filename || ''; midia = m.document?.id || ''; }
        else if (m.type === 'button') { texto = m.button?.text || ''; }
        else if (m.type === 'interactive') {
          const i = m.interactive || {};
          texto = i.button_reply?.title || i.list_reply?.title || JSON.stringify(i);
        }
        else if (m.type === 'reaction') { tipo = 'reaction'; texto = m.reaction?.emoji || ''; }
        else { texto = '[tipo: ' + m.type + ']'; }
        const ts = m.timestamp ? new Date((+m.timestamp) * 1000).toISOString() : new Date().toISOString();
        const reply_to_id = m.context?.id || (m.type === 'reaction' && m.reaction?.message_id) || '';
        rows.push({
          codigo: 'meta_' + m.id,
          conta_id, telefone,
          nome_contato: nomeMap[telefone] || '',
          direcao: 'in', tipo, texto,
          midia_url: midia, // temporariamente guarda media_id; processamento async troca por data:base64
          timestamp: ts,
          status: 'entregue',
          external_id: m.id || '',
          atendente: '',
          reply_to_id,
          reply_to_texto: '',
          is_media: ['image', 'audio', 'video', 'document', 'gif', 'sticker'].includes(tipo),
          raw_media_id: midia,
        });
      }
    }
  }
  return rows;
}

function parseStatuses(body) {
  const stMap = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'erro' };
  const updates = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const e of entries) {
    const changes = Array.isArray(e.changes) ? e.changes : [];
    for (const ch of changes) {
      const v = ch.value || {};
      for (const s of (Array.isArray(v.statuses) ? v.statuses : [])) {
        const novo = stMap[s.status];
        if (s.id && novo) updates.push({ external_id: s.id, novo });
      }
    }
  }
  return updates;
}

async function inserirMensagens(rows) {
  // INSERT com ON CONFLICT (codigo) pra idempotencia (Meta pode reenviar o msm webhook)
  for (const r of rows) {
    try {
      await query(
        `INSERT INTO chat_mensagens
           (codigo, conta_id, telefone, nome_contato, direcao, tipo, texto,
            midia_url, timestamp, status, external_id, atendente,
            reply_to_id, reply_to_texto)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14)
         ON CONFLICT (codigo) DO NOTHING`,
        [r.codigo, r.conta_id, r.telefone, r.nome_contato, r.direcao, r.tipo, r.texto,
          r.midia_url || '', r.timestamp, r.status, r.external_id, r.atendente,
          r.reply_to_id, r.reply_to_texto]
      );
    } catch (err) {
      console.error('[inbound] falha ao inserir msg', r.codigo, err.message);
    }
  }
}

async function atualizarStatuses(updates) {
  for (const u of updates) {
    try {
      await query(
        `UPDATE chat_mensagens
         SET status = CASE
           WHEN $1 = 'lido' THEN 'lido'
           WHEN $1 = 'entregue' AND status = 'enviado' THEN 'entregue'
           WHEN $1 = 'erro' THEN 'erro'
           ELSE status
         END
         WHERE external_id = $2 AND direcao = 'out'`,
        [u.novo, u.external_id]
      );
    } catch (err) {
      console.error('[inbound] falha ao atualizar status', u.external_id, err.message);
    }
  }
}

// Baixa midia da Meta (2 etapas: GET /{media_id} -> URL -> GET URL binary)
async function baixarMidia(media_id, accessToken) {
  try {
    const r1 = await fetch(`https://graph.facebook.com/${config.metaApiVersion || 'v20.0'}/${media_id}`, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const meta = await r1.json();
    if (!r1.ok || !meta.url) return null;
    const r2 = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!r2.ok) return null;
    const buf = Buffer.from(await r2.arrayBuffer());
    return `data:${meta.mime_type || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error('[inbound] baixarMidia falhou', media_id, err.message);
    return null;
  }
}

async function processarMidiasAsync(mediaRows) {
  // Agrupa por conta pra buscar o access_token 1x por conta
  const porConta = new Map();
  for (const r of mediaRows) {
    if (!porConta.has(r.conta_id)) porConta.set(r.conta_id, []);
    porConta.get(r.conta_id).push(r);
  }
  for (const [conta_id, rows] of porConta.entries()) {
    try {
      const contaRes = await query(`SELECT config FROM chat_contas WHERE codigo=$1 LIMIT 1`, [conta_id]);
      if (!contaRes.rows.length) continue;
      let cfg = {};
      try { cfg = typeof contaRes.rows[0].config === 'string' ? JSON.parse(contaRes.rows[0].config) : (contaRes.rows[0].config || {}); } catch (_) {}
      if (!cfg.access_token) continue;
      for (const r of rows) {
        if (!r.raw_media_id) continue;
        const dataUrl = await baixarMidia(r.raw_media_id, cfg.access_token);
        if (dataUrl) {
          await query(`UPDATE chat_mensagens SET midia_url=$1 WHERE codigo=$2`, [dataUrl, r.codigo]);
        }
      }
    } catch (err) {
      console.error('[inbound] processarMidiasAsync falhou pra conta', conta_id, err.message);
    }
  }
}

export default async function inboundRoutes(fastify) {
  // GET: verify token (handshake inicial da Meta)
  fastify.get('/webhook/chat-inbound-meta', async (req, reply) => {
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];
    if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
      reply.type('text/plain').send(challenge || 'ok');
      return;
    }
    reply.code(403).send('forbidden');
  });

  // POST: msgs novas + status
  fastify.post('/webhook/chat-inbound-meta', async (req, reply) => {
    const body = req.body || {};

    // Processa sincrono as partes RAPIDAS (parse + insert). Midia roda async.
    try {
      if (hasDb()) {
        const rows = parseMensagens(body);
        const statuses = parseStatuses(body);

        // Inserir mensagens primeiro (sem a midia ainda — so o media_id)
        if (rows.length) await inserirMensagens(rows);
        if (statuses.length) await atualizarStatuses(statuses);

        // Baixar midia em background (fire-and-forget) — Meta nao espera
        const mediaRows = rows.filter(r => r.is_media && r.raw_media_id);
        if (mediaRows.length) {
          setImmediate(() => processarMidiasAsync(mediaRows));
        }
      }
    } catch (err) {
      console.error('[inbound] erro geral', err.message);
    }

    // Meta exige 200 em <5s — SEMPRE responde ok
    return { ok: true };
  });
}
