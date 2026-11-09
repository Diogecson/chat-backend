// /webhook/painel-ajuda-ia-chat — Coach de vendas IA (Claude)
// Analisa historico da conversa e sugere proxima mensagem pro consultor enviar.
// Requer ANTHROPIC_API_KEY no env.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const SYSTEM_PROMPT = `Voce e um COACH DE VENDAS senior da UniFECAF, universidade de Sao Paulo focada em EAD (Ensino a Distancia) e cursos semi-presenciais.

Seu trabalho: ajudar o consultor comercial a decidir a PROXIMA mensagem a enviar no WhatsApp pro candidato/lead, baseado no historico da conversa.

REGRAS:
- Responda SEMPRE em portugues do Brasil, tom natural de WhatsApp (nao formal demais, nao de atendimento de call center).
- Seja direto: entre 1 e 3 paragrafos curtos.
- Nao use emojis em excesso (no maximo 1-2 quando fizer sentido).
- Nao prometa valores/descontos especificos sem base — se o consultor nao disse ainda, sugira "Quero te passar uma condicao especial agora, posso te ligar?".
- Objetivos tipicos: entender o curso de interesse, qualificar (ja tem 2o grau? ja fez ENEM?), convidar para visita ao polo OU para matricula online.
- Se o lead parou de responder, sugira uma mensagem leve de reengajamento (nao cobrar).
- Se o lead ja disse que nao quer ou pediu pra parar, NAO insista.
- Se faltam informacoes criticas (curso, polo, idade), a sugestao deve PERGUNTAR.
- Nunca mencione preco de concorrente, nem invente dados da UniFECAF.

Formato da resposta: APENAS o texto da mensagem sugerida, sem explicacoes, sem prefixos tipo "Sugiro:" ou "Resposta:". Escreva como se o consultor fosse copiar e colar.`;

async function chamarClaude({ historico, nomeLead, prompt_extra }) {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, erro: 'ANTHROPIC_API_KEY nao configurada no env do backend' };
  }

  const linhasHist = historico.map(m => {
    const quem = m.direcao === 'in' ? 'CLIENTE' : 'CONSULTOR';
    const texto = (m.texto || `[${m.tipo || 'midia'}]`).substring(0, 500);
    return `${quem}: ${texto}`;
  }).join('\n');

  const userMsg = `Lead: ${nomeLead || 'desconhecido'}

Historico da conversa (mais antigo primeiro):
---
${linhasHist}
---

${prompt_extra ? 'Instrucao adicional do consultor: ' + prompt_extra + '\n\n' : ''}Qual deve ser a PROXIMA mensagem do consultor? Responda apenas o texto da mensagem.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      return { ok: false, erro: data?.error?.message || `HTTP ${r.status}` };
    }
    // Extrai texto do primeiro bloco text
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const sugestao = (textBlock?.text || '').trim();
    if (!sugestao) return { ok: false, erro: 'IA retornou vazio' };
    return { ok: true, sugestao, usage: data.usage };
  } catch (err) {
    return { ok: false, erro: 'Falha ao chamar Claude: ' + err.message };
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

    // Puxa ate 30 ultimas mensagens em ordem cronologica
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

    const res = await chamarClaude({ historico, nomeLead: nome, prompt_extra });
    if (!res.ok) {
      reply.code(500);
      return res;
    }
    return { ok: true, sugestao: res.sugestao };
  }
  fastify.post('/webhook/painel-ajuda-ia-chat', handle);
  fastify.post('/api/chat/ajuda-ia', handle);
}
