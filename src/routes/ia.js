// /webhook/painel-ajuda-ia-chat — Coach de vendas IA
//
// Arquitetura:
// 1) Le ate 30 msgs da conversa do Postgres (chat_mensagens)
// 2) Monta o historico formatado
// 3) Chama o fluxo n8n /webhook/ajuda-ia-chat que roda GPT com a credencial
//    "GPT DG PAGO" (openAiApi id NK9ttQkECOReZ71h) — zero chave no backend
// 4) Devolve {ok, sugestao} pro frontend
//
// Se o fluxo n8n estiver OFF, cai num erro claro no frontend.

import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const N8N_UPSTREAM = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';
const AJUDA_IA_WEBHOOK = process.env.AJUDA_IA_WEBHOOK || `${N8N_UPSTREAM}/webhook/ajuda-ia-chat`;
const CORRIGIR_WEBHOOK = process.env.CORRIGIR_WEBHOOK || `${N8N_UPSTREAM}/webhook/chat-corrigir-texto`;

async function chamarN8N({ historico, nomeLead, prompt_extra }) {
  const linhasHist = historico.map(m => {
    const quem = m.direcao === 'in' ? 'CLIENTE' : 'CONSULTOR';
    const texto = (m.texto || `[${m.tipo || 'midia'}]`).substring(0, 500);
    return `${quem}: ${texto}`;
  }).join('\n');

  try {
    const r = await fetch(AJUDA_IA_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        historico: linhasHist,
        nomeLead: nomeLead || 'desconhecido',
        prompt_extra: prompt_extra || '',
      }),
    });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch (_) { data = { ok: false, erro: 'Resposta nao-JSON do n8n: ' + txt.substring(0, 200) }; }
    if (!r.ok) {
      return { ok: false, erro: data?.erro || data?.message || `HTTP ${r.status} do n8n` };
    }
    const sugestao = (data.sugestao || data.output || '').trim();
    if (!sugestao) return { ok: false, erro: 'IA retornou vazio' };
    return { ok: true, sugestao };
  } catch (err) {
    return { ok: false, erro: 'Falha ao chamar n8n: ' + err.message };
  }
}

export default async function iaRoutes(fastify) {
  async function handle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const b = req.body || {};
    const conta_id = String(b.conta_id || '');
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    const nome = String(b.nome || '');
    const prompt_extra = String(b.prompt_extra || b.instrucao || '').substring(0, 500);

    if (!conta_id || !telefone) {
      return reply.code(400).send({ ok: false, erro: 'conta_id e telefone obrigatorios' });
    }

    const r = await query(
      `SELECT direcao, tipo, texto, timestamp
       FROM chat_mensagens
       WHERE conta_id=$1 AND telefone=$2
       ORDER BY timestamp DESC LIMIT 30`,
      [conta_id, telefone]
    );
    const historico = (r.rows || []).reverse();
    if (!historico.length) {
      return { ok: false, erro: 'Sem mensagens nessa conversa' };
    }

    const res = await chamarN8N({ historico, nomeLead: nome, prompt_extra });
    if (!res.ok) {
      reply.code(500);
      return res;
    }
    return { ok: true, sugestao: res.sugestao };
  }
  fastify.post('/webhook/painel-ajuda-ia-chat', handle);
  fastify.post('/api/chat/ajuda-ia', handle);

  // === /webhook/chat-corrigir-texto ===
  // Proxy pro fluxo n8n "chat-corrigir-texto" (ortografia + 2 sugestões de reescrita).
  // Body esperado: { texto, conta_id?, telefone?, contexto? }.
  // Resposta: { ok:true, original, corrigido, sugestoes:[{titulo,texto}] } ou { ok:false, erro }.
  async function corrigirHandle(req, reply) {
    let b = req.body || {};
    // Frontend manda Content-Type: text/plain; Fastify entrega string crua.
    if (typeof b === 'string') {
      try { b = JSON.parse(b); } catch (_) { b = {}; }
    }
    const texto = String(b.texto || '').slice(0, 2000);
    const contexto = String(b.contexto || '').slice(0, 4000);
    if (!texto.trim()) {
      return reply.code(400).send({ ok: false, erro: 'texto obrigatorio' });
    }
    try {
      const r = await fetch(CORRIGIR_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto, contexto }),
      });
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch (_) {
        reply.code(502);
        return { ok: false, erro: 'Resposta nao-JSON do n8n: ' + txt.substring(0, 200) };
      }
      if (!r.ok || !data || data.ok === false) {
        reply.code(r.ok ? 500 : r.status);
        return { ok: false, erro: (data && data.erro) || `HTTP ${r.status} do n8n` };
      }
      return {
        ok: true,
        original: String(data.original || texto),
        corrigido: String(data.corrigido || ''),
        sugestoes: Array.isArray(data.sugestoes) ? data.sugestoes : [],
      };
    } catch (err) {
      reply.code(502);
      return { ok: false, erro: 'Falha ao chamar n8n: ' + err.message };
    }
  }
  fastify.post('/webhook/chat-corrigir-texto', corrigirHandle);
  fastify.post('/api/chat/corrigir-texto', corrigirHandle);
}
