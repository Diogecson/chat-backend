// Engine de triagem — portado de workflow-triagem-cron.json (n8n)
// Roda a cada 10s, pega sessoes ativas e dispara mensagens/decisoes.
// Reusa /webhook/chat-enviar e /webhook/chat-conversa-finalizar via fastify.inject.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const GEMINI_KEY = process.env.GEMINI_KEY || '';
const INTERVAL_MS = parseInt(process.env.TRIAGEM_INTERVAL_MS || '10000', 10);

// ---------- helpers ----------
function msgFromPasso(p) {
  const tipo = String((p && p.tipo_resposta) || 'text').toLowerCase();
  let opcoes = (p && p.opcoes) || [];
  if (typeof opcoes === 'string') { try { opcoes = JSON.parse(opcoes); } catch (_) { opcoes = []; } }
  const tipoFinal = (tipo === 'buttons' || tipo === 'list') ? tipo : 'text';
  return { text: (p && p.mensagem) || '', tipo_resposta: tipoFinal, opcoes: Array.isArray(opcoes) ? opcoes : [] };
}
function msgText(t) { return { text: String(t || ''), tipo_resposta: 'text', opcoes: [] }; }

function acharOpcaoEscolhida(passo, resposta) {
  const tipo = String(passo.tipo_resposta || '').toLowerCase();
  if (tipo !== 'buttons' && tipo !== 'list') return null;
  let opcoes = passo.opcoes;
  if (typeof opcoes === 'string') { try { opcoes = JSON.parse(opcoes); } catch (_) { opcoes = []; } }
  if (!Array.isArray(opcoes) || !opcoes.length) return null;
  const r = String(resposta || '').trim().toLowerCase();
  return opcoes.find(o => String(o.titulo || '').trim().toLowerCase() === r) || null;
}

async function validarComGemini(passo, resposta) {
  if (!GEMINI_KEY) return { valida: true }; // sem chave -> aceita sem validar
  try {
    const prompt = `Voce eh um validador. Passo atual: "${passo.mensagem}". Criterio: ${passo.validacao_prompt}. Resposta do cliente: "${resposta}". Responda APENAS 'VALIDA' se a resposta atende o criterio ou 'INVALIDA: <motivo curto>' se nao.`;
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(GEMINI_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 80 } }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const txt = ((j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '').trim().toUpperCase();
    if (txt.startsWith('INVALIDA')) {
      return { valida: false, motivo: txt.replace(/^INVALIDA:?\s*/, '').substring(0, 120) };
    }
    return { valida: true };
  } catch (_) {
    return { valida: true };
  }
}

async function buscarKbMatch(passo_codigo, texto) {
  try {
    const r = await query(
      `SELECT id, resposta, chaves,
              (SELECT COUNT(*) FROM unnest(chaves) k WHERE position(lower(k) IN $2) > 0) AS score
       FROM chat_triagem_conhecimento
       WHERE passo_codigo=$1 AND ativo=true
       ORDER BY score DESC, ordem ASC
       LIMIT 1`,
      [passo_codigo, String(texto || '').toLowerCase()]
    );
    const top = r.rows[0];
    if (!top || Number(top.score) === 0) return null;
    return { resposta: top.resposta, entrada_id: top.id, score: Number(top.score) };
  } catch (_) { return null; }
}

async function enviarMensagem(fastify, { conta_id, telefone, msg }) {
  const tipo = String(msg.tipo_resposta || 'text').toLowerCase();
  const isInteractive = tipo === 'buttons' || tipo === 'list';
  const payload = {
    token: 'TRIAGEM_IA', usuario: 'triagem_ia',
    conta_id, telefone,
    tipo: isInteractive ? 'interactive' : 'text',
    texto: msg.text,
    interactive_type: tipo === 'list' ? 'list' : 'button',
    opcoes: msg.opcoes || [],
  };
  try {
    await fastify.inject({ method: 'POST', url: '/webhook/chat-enviar',
      headers: { 'Content-Type': 'application/json' }, payload });
  } catch (err) {
    fastify.log.error('[triagem-engine] enviar falhou: ' + err.message);
  }
}

async function fecharConversa(fastify, { conta_id, telefone, motivo }) {
  try {
    await fastify.inject({ method: 'POST', url: '/webhook/chat-conversa-finalizar',
      headers: { 'Content-Type': 'application/json' },
      payload: { token: 'TRIAGEM_IA', usuario: 'triagem_ia', conta_id, telefone, motivo: motivo || '' } });
  } catch (err) {
    fastify.log.error('[triagem-engine] fechar falhou: ' + err.message);
  }
}

const SQL_GET_CFG = `
  SELECT codigo, nome, ativa, ativa_auto, ativa_por_palavra_chave, palavras_chave,
         contas_ids,
         COALESCE(mensagem_inicial,'') AS mensagem_inicial,
         COALESCE(mensagem_final,'') AS mensagem_final,
         COALESCE(max_tentativas,2) AS max_tentativas
  FROM chat_triagem_config`;

const SQL_GET_PASSOS = `
  SELECT codigo, ordem, campo, mensagem, validacao_prompt, tipo_resposta, opcoes, triagem_codigo,
         COALESCE(fallback_codigo,'') AS fallback_codigo
  FROM chat_triagem_passos WHERE ativo=true
  ORDER BY triagem_codigo, ordem ASC`;

const SQL_AUTO_CRIAR = `
  WITH cfg AS (
    SELECT codigo, contas_ids, ativa_auto, ativa_por_palavra_chave, palavras_chave
    FROM chat_triagem_config WHERE ativa=true LIMIT 1
  ),
  cand_auto AS (
    SELECT DISTINCT m.conta_id, m.telefone
    FROM chat_mensagens m, cfg
    WHERE cfg.ativa_auto = true
      AND m.direcao='in'
      AND m.timestamp > NOW() - INTERVAL '15 minutes'
      AND (cardinality(cfg.contas_ids)=0 OR m.conta_id = ANY(cfg.contas_ids))
      AND NOT EXISTS (
        SELECT 1 FROM chat_mensagens m2
        WHERE m2.conta_id=m.conta_id AND m2.telefone=m.telefone AND m2.timestamp < m.timestamp
      )
  ),
  cand_kw AS (
    SELECT ultima.conta_id, ultima.telefone
    FROM (
      SELECT DISTINCT ON (m.conta_id, m.telefone) m.conta_id, m.telefone, m.texto
      FROM chat_mensagens m
      WHERE m.direcao='in' AND m.timestamp > NOW() - INTERVAL '2 minutes'
      ORDER BY m.conta_id, m.telefone, m.timestamp DESC
    ) ultima
    CROSS JOIN cfg
    WHERE cfg.ativa_por_palavra_chave = true
      AND cardinality(cfg.palavras_chave) > 0
      AND (cardinality(cfg.contas_ids)=0 OR ultima.conta_id = ANY(cfg.contas_ids))
      AND EXISTS (
        SELECT 1 FROM unnest(cfg.palavras_chave) AS kw
        WHERE LOWER(ultima.texto) LIKE '%' || LOWER(kw) || '%'
      )
  ),
  cand AS ( SELECT * FROM cand_auto UNION SELECT * FROM cand_kw ),
  filtrados AS (
    SELECT c.conta_id, c.telefone
    FROM cand c
    LEFT JOIN chat_conversa_dono cd ON cd.conta_id=c.conta_id AND cd.telefone=c.telefone
    WHERE (cd.atendente IS NULL OR cd.atendente = '' OR LOWER(cd.atendente) IN ('sistema','ia_followup','triagem_ia') OR cd.atendente LIKE 'disparo%')
      AND NOT EXISTS (
        SELECT 1 FROM chat_triagem_sessoes s
        WHERE s.conta_id=c.conta_id AND s.telefone=c.telefone
          AND ( s.status='ativa'
                OR (s.status='concluida' AND s.concluida_em > NOW() - INTERVAL '2 hours') )
      )
  )
  INSERT INTO chat_triagem_sessoes (conta_id, telefone, triagem_codigo, passo_atual, status, iniciada_por)
  SELECT f.conta_id, f.telefone, (SELECT codigo FROM cfg), 0, 'ativa', 'auto'
  FROM filtrados f
  RETURNING id`;

const SQL_GET_SESSIONS = `
  SELECT s.id AS session_id, s.conta_id, s.telefone, s.passo_atual, s.respostas, s.tentativas_ultimo,
         COALESCE(s.triagem_codigo, 'default') AS triagem_codigo,
         m.codigo AS msg_codigo, m.texto AS msg_texto, m.timestamp AS msg_ts
  FROM chat_triagem_sessoes s
  LEFT JOIN LATERAL (
    SELECT codigo, texto, timestamp
    FROM chat_mensagens
    WHERE conta_id=s.conta_id AND telefone=s.telefone AND direcao='in'
      AND timestamp > s.ultima_msg_processada_em
    ORDER BY timestamp ASC LIMIT 1
  ) m ON true
  WHERE s.status='ativa'
    AND (s.passo_atual = 0 OR m.codigo IS NOT NULL)
  ORDER BY s.id ASC LIMIT 20`;

const SQL_UPDATE_SESSION = `
  UPDATE chat_triagem_sessoes
  SET passo_atual=$1,
      status=$2,
      respostas=$3::jsonb,
      tentativas_ultimo=$4,
      ultima_msg_processada_em=$5::timestamptz,
      concluida_em = CASE WHEN $2='concluida' THEN NOW() ELSE concluida_em END,
      ultima_atualizacao=NOW()
  WHERE id=$6
  RETURNING id`;

async function processarSessao(fastify, s, cfgByCodigo, passosByCodigo, cfgDefault) {
  const triagemCodigo = s.triagem_codigo || (cfgDefault?.codigo || 'default');
  const cfg = cfgByCodigo[triagemCodigo] || cfgDefault || {};
  const passos = passosByCodigo[triagemCodigo] || [];
  const mensagemInicial = cfg.mensagem_inicial || 'Ola! Vamos comecar sua triagem.';
  const mensagemFinal = cfg.mensagem_final || 'Obrigado! Um consultor vai te atender em breve.';
  const maxTentativas = Number(cfg.max_tentativas || 2);
  const total = passos.length;
  const passoAtual = s.passo_atual;
  const nowIso = new Date().toISOString();

  if (total === 0) {
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(mensagemFinal) });
    await query(SQL_UPDATE_SESSION, [-1, 'concluida', JSON.stringify(s.respostas || {}), 0, nowIso, s.session_id]);
    return;
  }

  if (passoAtual === 0) {
    const p1 = passos[0];
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(mensagemInicial) });
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgFromPasso(p1) });
    await query(SQL_UPDATE_SESSION, [1, 'ativa', JSON.stringify(s.respostas || {}), 0, nowIso, s.session_id]);
    return;
  }

  if (!s.msg_codigo) return;
  const passoAtualObj = passos[passoAtual - 1];
  if (!passoAtualObj) return;

  const resposta = String(s.msg_texto || '').trim();
  const respostasNew = { ...(typeof s.respostas === 'object' && s.respostas ? s.respostas : {}) };
  const campo = passoAtualObj.campo || ('passo_' + passoAtual);
  const msgTs = s.msg_ts || nowIso;

  const opcaoBotao = acharOpcaoEscolhida(passoAtualObj, resposta);
  if (opcaoBotao && String(opcaoBotao.proximo_codigo || '').startsWith('__close__')) {
    const motivo = String(opcaoBotao.proximo_codigo).replace('__close__', '');
    respostasNew[campo] = resposta;
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(mensagemFinal) });
    await query(SQL_UPDATE_SESSION, [-1, 'concluida', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
    await fecharConversa(fastify, { conta_id: s.conta_id, telefone: s.telefone, motivo });
    return;
  }

  if (String(passoAtualObj.tipo_resposta || '').toLowerCase() === 'conhecimento') {
    const match = await buscarKbMatch(passoAtualObj.codigo, resposta);
    if (match) {
      respostasNew[campo] = resposta;
      await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(match.resposta) });
      await query(SQL_UPDATE_SESSION, [passoAtual, 'ativa', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
      return;
    }
    respostasNew[campo] = resposta;
    const proximoNum = passoAtual + 1;
    if (proximoNum > total) {
      await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(mensagemFinal) });
      await query(SQL_UPDATE_SESSION, [-1, 'concluida', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
    } else {
      await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgFromPasso(passos[proximoNum - 1]) });
      await query(SQL_UPDATE_SESSION, [proximoNum, 'ativa', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
    }
    return;
  }

  let respostaValida = true, motivoInvalida = '';
  if (passoAtualObj.validacao_prompt && passoAtualObj.validacao_prompt.trim()) {
    const v = await validarComGemini(passoAtualObj, resposta);
    if (!v.valida) { respostaValida = false; motivoInvalida = v.motivo; }
  }

  if (!respostaValida) {
    const tentativas = Number(s.tentativas_ultimo || 0) + 1;
    if (tentativas < maxTentativas) {
      const textoReenvio = `Nao entendi direito${motivoInvalida ? ' (' + motivoInvalida + ')' : ''}. Podemos tentar de novo?\n\n${passoAtualObj.mensagem}`;
      const msgReenvio = msgFromPasso(passoAtualObj); msgReenvio.text = textoReenvio;
      await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgReenvio });
      await query(SQL_UPDATE_SESSION, [passoAtual, 'ativa', JSON.stringify(respostasNew), tentativas, msgTs, s.session_id]);
      return;
    }
    respostasNew[campo] = resposta + ' [aceita apos ' + tentativas + ' tentativas]';
  } else {
    respostasNew[campo] = resposta;
  }

  if (opcaoBotao && opcaoBotao.proximo_codigo === '__end__') {
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(mensagemFinal) });
    await query(SQL_UPDATE_SESSION, [-1, 'concluida', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
    return;
  }

  const proximoNum = passoAtual + 1;
  if (proximoNum > total) {
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgText(mensagemFinal) });
    await query(SQL_UPDATE_SESSION, [-1, 'concluida', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
  } else {
    await enviarMensagem(fastify, { conta_id: s.conta_id, telefone: s.telefone, msg: msgFromPasso(passos[proximoNum - 1]) });
    await query(SQL_UPDATE_SESSION, [proximoNum, 'ativa', JSON.stringify(respostasNew), 0, msgTs, s.session_id]);
  }
}

export function startTriagemEngine(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[triagem-engine] DB nao configurado, engine nao sera iniciado');
    return;
  }
  let rodando = false;

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const [cfgs, passos] = await Promise.all([ query(SQL_GET_CFG), query(SQL_GET_PASSOS) ]);
      await query(SQL_AUTO_CRIAR).catch(e => fastify.log.error('[triagem-engine] auto-criar: ' + e.message));
      const sessoes = await query(SQL_GET_SESSIONS);
      if (!sessoes.rows.length) return;

      const cfgByCodigo = {};
      for (const c of cfgs.rows) { if (c.codigo) cfgByCodigo[c.codigo] = c; }
      const cfgDefault = cfgs.rows.find(c => c.ativa) || cfgs.rows[0] || null;

      const passosByCodigo = {};
      for (const p of passos.rows) {
        const tc = p.triagem_codigo || 'default';
        if (!passosByCodigo[tc]) passosByCodigo[tc] = [];
        passosByCodigo[tc].push(p);
      }
      for (const tc in passosByCodigo) {
        passosByCodigo[tc].sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
      }

      for (const s of sessoes.rows) {
        try {
          await processarSessao(fastify, s, cfgByCodigo, passosByCodigo, cfgDefault);
        } catch (err) {
          fastify.log.error(`[triagem-engine] session ${s.session_id}: ${err.message}`);
        }
      }
    } catch (err) {
      fastify.log.error('[triagem-engine] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 8000);
  fastify.log.info(`[triagem-engine] iniciado, intervalo=${INTERVAL_MS}ms`);
}
