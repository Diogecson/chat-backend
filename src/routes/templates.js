// /webhook/chat-template-create — cria template HSM na Meta (WABA)
// Migrado do workflow-template.json do n8n.
// GET /webhook/chat-templates tambem migrado aqui pra ficar unificado,
// mas se a versao do n8n ja esta funcionando, o Fastify sobrepoe.
import { query } from '../services/db.js';
import { hasDb, config } from '../config.js';

function p(body, name, def = '') {
  const v = body && body[name];
  if (v == null || v === '') return def;
  return v;
}

function normName(s) {
  return String(s||'').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

async function buscarConta(conta_id) {
  const r = await query(`SELECT * FROM chat_contas WHERE codigo=$1 AND tipo='meta' LIMIT 1`, [conta_id]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  let cfg = {};
  try { cfg = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {}); } catch (_) {}
  return { row, cfg };
}

function construirPayload(body) {
  const name = normName(body.name);
  const language = String(body.language || 'pt_BR');
  const category = String(body.category || 'MARKETING').toUpperCase();
  const body_text = String(body.body_text || '');
  const header_format = String(body.header_format || '').toUpperCase();
  const header_text = String(body.header_text || '');
  const footer_text = String(body.footer_text || '');
  const buttons = Array.isArray(body.buttons) ? body.buttons : [];
  const body_examples = Array.isArray(body.body_examples) ? body.body_examples : [];
  const header_examples = Array.isArray(body.header_examples) ? body.header_examples : [];

  const body_vars = body_text.match(/\{\{\d+\}\}/g) || [];
  const header_vars = header_text.match(/\{\{\d+\}\}/g) || [];

  const components = [];
  if (header_format === 'TEXT' && header_text) {
    const h = { type: 'HEADER', format: 'TEXT', text: header_text };
    if (header_vars.length) {
      h.example = { header_text: header_examples.length ? header_examples : header_vars.map(() => 'exemplo') };
    }
    components.push(h);
  }
  const bodyComp = { type: 'BODY', text: body_text };
  if (body_vars.length) {
    bodyComp.example = { body_text: [body_examples.length ? body_examples : body_vars.map(() => 'exemplo')] };
  }
  components.push(bodyComp);
  if (footer_text) components.push({ type: 'FOOTER', text: footer_text });
  if (buttons.length) {
    const btns = buttons.slice(0, 10).map(bt => {
      if (bt.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: String(bt.text || '').substring(0, 25) };
      if (bt.type === 'URL') return { type: 'URL', text: String(bt.text || '').substring(0, 25), url: bt.url || '' };
      if (bt.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: String(bt.text || '').substring(0, 25), phone_number: bt.phone_number || '' };
      return null;
    }).filter(Boolean);
    if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
  }

  return { name, language, category, components };
}

export default async function templatesRoutes(fastify) {
  // POST /webhook/chat-template-create — cria template HSM na Meta
  const templateCreate = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const conta_id = String(b.conta_id || '');
    const name = String(b.name || '');
    const body_text = String(b.body_text || '');
    if (!conta_id || !name || !body_text) {
      return reply.code(400).send({ ok: false, erro: 'conta_id, name e body_text sao obrigatorios' });
    }
    const conta = await buscarConta(conta_id);
    if (!conta) return reply.code(404).send({ ok: false, erro: 'Conta Meta nao encontrada: ' + conta_id });
    const cfg = conta.cfg;
    if (!cfg.waba_id || !cfg.access_token) {
      return reply.code(400).send({ ok: false, erro: 'Conta sem waba_id ou access_token no config' });
    }
    const payload = construirPayload(b);
    const url = `https://graph.facebook.com/${config.metaApiVersion || 'v20.0'}/${cfg.waba_id}/message_templates`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + cfg.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (data.error) {
        return reply.code(200).send({ ok: false, erro: data.error.message || 'Erro Meta', error_code: data.error.code, raw: data });
      }
      if (data.id) {
        return { ok: true, id: data.id, status: data.status || 'PENDING', category: data.category };
      }
      return { ok: false, erro: 'Resposta inesperada da Meta', raw: data };
    } catch (err) {
      return reply.code(500).send({ ok: false, erro: 'Falha ao chamar Meta: ' + err.message });
    }
  };
  fastify.post('/webhook/chat-template-create', templateCreate);
  fastify.post('/api/chat/template-create', templateCreate);

  // GET /webhook/chat-templates — lista templates aprovados da conta
  const templatesList = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const conta_id = String(req.query?.conta_id || req.body?.conta_id || '');
    if (!conta_id) return reply.code(400).send({ ok: false, erro: 'conta_id obrigatorio' });
    const conta = await buscarConta(conta_id);
    if (!conta) return reply.code(404).send({ ok: false, erro: 'Conta Meta nao encontrada: ' + conta_id });
    const cfg = conta.cfg;
    if (!cfg.waba_id || !cfg.access_token) {
      return reply.code(400).send({ ok: false, erro: 'Conta sem waba_id ou access_token no config' });
    }
    const url = `https://graph.facebook.com/${config.metaApiVersion || 'v20.0'}/${cfg.waba_id}/message_templates?limit=200&fields=name,status,category,language,components`;
    try {
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + cfg.access_token },
      });
      const data = await r.json().catch(() => ({}));
      if (data.error) {
        return reply.code(200).send({ ok: false, erro: data.error.message || 'Erro Meta', raw: data });
      }
      return { ok: true, templates: Array.isArray(data.data) ? data.data : [], paging: data.paging || null };
    } catch (err) {
      return reply.code(500).send({ ok: false, erro: 'Falha ao chamar Meta: ' + err.message });
    }
  };
  fastify.get('/webhook/chat-templates', templatesList);
  fastify.post('/webhook/chat-templates', templatesList);
}
