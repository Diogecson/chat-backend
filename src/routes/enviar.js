// chat-enviar: endpoint que recebe POST do chat.html e envia pra Meta API + grava chat_mensagens
// Migrado do workflow-chat-enviar-CORRIGIDO.json do n8n (foco em template + text).
// Audio/media/interactive/evolution continuam passando pelo proxy pro n8n antigo até migrar.
import { query, getPool } from '../services/db.js';
import { hasDb, config } from '../config.js';
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

// Converte audio pra audio/ogg (libopus) — Meta nao aceita webm nem outros exoticos
async function converterAudioParaOgg(buffer, inputExt) {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const ext = (inputExt || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase().substring(0, 6) || 'webm';
  const inPath = path.join(os.tmpdir(), `aud_in_${id}.${ext}`);
  const outPath = path.join(os.tmpdir(), `aud_out_${id}.ogg`);
  await fs.promises.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .audioCodec('libopus')
        .audioBitrate('32k')
        .format('ogg')
        .on('end', resolve)
        .on('error', reject)
        .save(outPath);
    });
    const out = await fs.promises.readFile(outPath);
    return out;
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

function p(body, name, def = '') {
  const v = body && body[name];
  if (v == null || v === '') return def;
  return v;
}

function geraCodigo() {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function enviarMetaTemplate({ accountCfg, telefone, template_name, template_language, template_body_vars }) {
  const url = `https://graph.facebook.com/${config.metaApiVersion}/${accountCfg.phone_number_id}/messages`;
  const components = [];
  if (template_body_vars && template_body_vars.length) {
    components.push({
      type: 'body',
      parameters: template_body_vars.map(v => ({ type: 'text', text: String(v || '') })),
    });
  }
  const body = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: template_name,
      language: { code: template_language || 'pt_BR' },
      components,
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accountCfg.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    return { ok: false, error: data?.error?.message || `HTTP ${r.status}`, raw: data };
  }
  return { ok: true, wamid: data?.messages?.[0]?.id || '', raw: data };
}

async function enviarMetaText({ accountCfg, telefone, texto, reply_to_id }) {
  const url = `https://graph.facebook.com/${config.metaApiVersion}/${accountCfg.phone_number_id}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'text',
    text: { body: texto, preview_url: false },
  };
  if (reply_to_id) body.context = { message_id: reply_to_id };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accountCfg.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    return { ok: false, error: data?.error?.message || `HTTP ${r.status}`, raw: data };
  }
  return { ok: true, wamid: data?.messages?.[0]?.id || '', raw: data };
}

// Upload de midia pro Meta: recebe base64, envia multipart, retorna media_id
async function uploadMetaMedia({ accountCfg, base64, mimetype, filename }) {
  const url = `https://graph.facebook.com/${config.metaApiVersion}/${accountCfg.phone_number_id}/media`;
  const buffer = Buffer.from(base64, 'base64');
  const blob = new Blob([buffer], { type: mimetype });
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mimetype);
  fd.append('file', blob, filename || 'upload.bin');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accountCfg.access_token}` },
    body: fd,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    return { ok: false, error: data?.error?.message || `HTTP ${r.status}`, raw: data };
  }
  return { ok: true, media_id: data.id };
}

// Envia mensagem de mídia (image/video/audio/document) usando media_id
async function enviarMetaMedia({ accountCfg, telefone, tipo, media_id, caption, filename, reply_to_id }) {
  const url = `https://graph.facebook.com/${config.metaApiVersion}/${accountCfg.phone_number_id}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: tipo,
  };
  const mediaObj = { id: media_id };
  if (tipo === 'image' || tipo === 'video') {
    if (caption) mediaObj.caption = caption;
  } else if (tipo === 'document') {
    if (caption) mediaObj.caption = caption;
    if (filename) mediaObj.filename = filename;
  }
  // audio nao aceita caption nem filename
  payload[tipo] = mediaObj;
  if (reply_to_id) payload.context = { message_id: reply_to_id };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accountCfg.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    return { ok: false, error: data?.error?.message || `HTTP ${r.status}`, raw: data };
  }
  return { ok: true, wamid: data?.messages?.[0]?.id || '', raw: data };
}

export default async function enviarRoutes(fastify) {
  async function handleEnviar(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const conta_id = String(p(b, 'conta_id'));
    const telefone = String(p(b, 'telefone')).replace(/\D/g, '');
    const tipo = String(p(b, 'tipo', 'text')).toLowerCase();
    const usuario = String(p(b, 'usuario', 'sistema'));
    const texto = String(p(b, 'texto', ''));
    const reply_to_id = String(p(b, 'reply_to_id', ''));
    const reply_to_texto = String(p(b, 'reply_to_texto', '')).substring(0, 500);

    // Dados de template
    const template_name = String(p(b, 'template_name', ''));
    const template_language = String(p(b, 'template_language', 'pt_BR'));
    const template_body_vars = Array.isArray(b.template_body_vars) ? b.template_body_vars : [];
    const template_body_text = String(p(b, 'template_body_text', ''));

    // Dados de midia
    const midia_base64 = String(p(b, 'midia_base64', ''));
    const mimetype = String(p(b, 'mimetype', ''));
    const filename = String(p(b, 'filename', ''));

    if (!conta_id || !telefone) {
      return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatórios' });
    }

    // Tipos suportados nativamente: text, template, image, video, audio, document
    // Os demais (sticker, interactive, location...) continuam no proxy pro n8n
    const tiposSuportados = new Set(['text', 'template', 'image', 'video', 'audio', 'document']);
    if (!tiposSuportados.has(tipo)) {
      try {
        const upstream = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';
        const r = await fetch(`${upstream}/webhook/chat-enviar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b),
        });
        const data = await r.json().catch(() => ({}));
        return data;
      } catch (err) {
        return reply.code(502).send({ ok: false, erro: 'proxy n8n falhou: ' + err.message });
      }
    }

    // Busca config da conta
    const contaRes = await query(
      `SELECT codigo, nome, tipo, config FROM chat_contas WHERE codigo=$1 LIMIT 1`,
      [conta_id]
    );
    if (!contaRes.rows.length) {
      return reply.code(404).send({ ok: false, erro: 'conta_nao_encontrada: ' + conta_id });
    }
    const conta = contaRes.rows[0];
    let accountCfg = {};
    try {
      accountCfg = typeof conta.config === 'string' ? JSON.parse(conta.config) : (conta.config || {});
    } catch (_) {}

    if (conta.tipo !== 'meta') {
      // Evolution — não suportado ainda, delega pro proxy
      try {
        const upstream = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';
        const r = await fetch(`${upstream}/webhook/chat-enviar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b),
        });
        return await r.json().catch(() => ({ ok: false }));
      } catch (err) {
        return reply.code(502).send({ ok: false, erro: 'evolution proxy falhou' });
      }
    }

    // Monta texto final (pra gravar em chat_mensagens)
    let textoFinal = texto;
    if (tipo === 'template') {
      // Prioridade: template_body_text (cru com placeholders) → substitui vars
      //             → senão usa 'texto' (front já mandou o preview montado)
      //             → último recurso: '[template: nome]'
      if (template_body_text) {
        textoFinal = template_body_text;
        template_body_vars.forEach((v, i) => {
          textoFinal = textoFinal.replace(new RegExp('\\{\\{\\s*' + (i + 1) + '\\s*\\}\\}', 'g'), String(v || ''));
        });
      } else if (texto) {
        textoFinal = texto;  // front mandou preview pronto
      } else {
        textoFinal = `[template: ${template_name}]`;
      }
    } else if (tipo === 'image' || tipo === 'video' || tipo === 'audio' || tipo === 'document') {
      // Pra midia: caption (texto) ou label do tipo
      if (!textoFinal) {
        if (tipo === 'document' && filename) textoFinal = `[${tipo}: ${filename}]`;
        else textoFinal = `[${tipo}]`;
      }
    }

    // DRY_RUN: não chama Meta, só grava com wamid fake
    let res;
    if (config.dryRun) {
      console.log(`[DRY_RUN] send ${tipo} "${template_name || texto.substring(0, 40)}" to ${telefone}`);
      res = { ok: true, wamid: `wamid.DRYRUN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, dryRun: true };
    } else {
      if (tipo === 'template') {
        if (!template_name) return reply.code(400).send({ ok: false, erro: 'template_name obrigatório' });
        res = await enviarMetaTemplate({ accountCfg, telefone, template_name, template_language, template_body_vars });
      } else if (tipo === 'image' || tipo === 'video' || tipo === 'audio' || tipo === 'document') {
        if (!midia_base64) return reply.code(400).send({ ok: false, erro: 'midia_base64 obrigatório pra midia' });
        let b64Para = midia_base64;
        let mimePara = mimetype;
        // Meta so aceita audio nos tipos: aac, mp4, mpeg, amr, ogg, opus.
        // Chrome/Firefox gravam em audio/webm por default. Converte pra audio/ogg via ffmpeg.
        if (tipo === 'audio') {
          const mimeBase = String(mimetype || '').split(';')[0].toLowerCase();
          const precisaConverter = !['audio/aac','audio/mp4','audio/mpeg','audio/amr','audio/ogg','audio/opus'].includes(mimeBase);
          if (precisaConverter) {
            try {
              const inputBuf = Buffer.from(midia_base64, 'base64');
              const inputExt = mimeBase.includes('webm') ? 'webm' : (mimeBase.split('/')[1] || 'webm');
              const oggBuf = await converterAudioParaOgg(inputBuf, inputExt);
              b64Para = oggBuf.toString('base64');
              mimePara = 'audio/ogg';
            } catch (err) {
              return { ok: false, erro: 'conversao de audio falhou: ' + err.message };
            }
          }
        }
        // 1) Upload pro Meta → media_id
        const up = await uploadMetaMedia({ accountCfg, base64: b64Para, mimetype: mimePara, filename });
        if (!up.ok) {
          return { ok: false, erro: 'upload falhou: ' + up.error, api: up.raw };
        }
        // Guarda pra o INSERT abaixo usar o buffer convertido
        b.__midia_base64_final = b64Para;
        b.__mimetype_final = mimePara;
        // 2) Envia mensagem com media_id
        res = await enviarMetaMedia({
          accountCfg, telefone, tipo, media_id: up.media_id,
          caption: texto, filename, reply_to_id
        });
      } else {
        if (!texto) return reply.code(400).send({ ok: false, erro: 'texto obrigatório' });
        res = await enviarMetaText({ accountCfg, telefone, texto, reply_to_id });
      }
    }

    if (!res.ok) {
      return { ok: false, erro: res.error, api: res.raw };
    }

    // Grava em chat_mensagens
    const codigo = geraCodigo();
    const external_id = res.wamid || '';
    // Para midia OUT, grava data:URL pra o player conseguir tocar/exibir no chat.html
    let midiaUrlOut = '';
    if ((tipo === 'audio' || tipo === 'image' || tipo === 'video' || tipo === 'document') && midia_base64) {
      // Usa buffer CONVERTIDO se audio passou por ffmpeg (b.__midia_base64_final)
      const b64Final = b.__midia_base64_final || midia_base64;
      const mimeFinal = b.__mimetype_final || mimetype;
      if (String(b64Final).startsWith('data:')) {
        midiaUrlOut = b64Final;
      } else {
        const mime = mimeFinal || (tipo === 'audio' ? 'audio/ogg' : tipo === 'image' ? 'image/jpeg' : 'application/octet-stream');
        midiaUrlOut = `data:${mime};base64,${b64Final}`;
      }
    }
    let row;
    try {
      const insRes = await query(
        `INSERT INTO chat_mensagens
          (codigo, conta_id, telefone, nome_contato, direcao, tipo, texto,
           midia_url, timestamp, status, external_id, atendente,
           reply_to_id, reply_to_texto)
         VALUES ($1,$2,$3,'','out',$4,$5,$10,NOW(),'enviado',$6,$7,$8,$9)
         RETURNING id, conta_id, telefone, texto, timestamp, external_id, atendente`,
        [codigo, conta_id, telefone, tipo, textoFinal, external_id, usuario, reply_to_id, reply_to_texto, midiaUrlOut]
      );
      row = insRes.rows[0];
    } catch (err) {
      return { ok: true, erro_gravacao: err.message, mensagem: { external_id } };
    }

    return { ok: true, mensagem: row, api: res.raw };
  }

  fastify.post('/webhook/chat-enviar', handleEnviar);
  fastify.post('/api/chat/enviar', handleEnviar);
}
