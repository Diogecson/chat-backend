// /webhook/chat-gestao-* — pagina gestao.html (metricas, detalhes, lista conv, analise IA)
// Migrado do workflow-gestao-routes.json + workflow-gestao-detalhes.json + workflow-gestao-conversas-list.json
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

function p(req, name, def = '') {
  const b = req.body || {};
  const q = req.query || {};
  const v = (b[name] != null && b[name] !== '') ? b[name] : (q[name] != null && q[name] !== '' ? q[name] : def);
  return v;
}

function sanitAtd(s) { return String(s || '').replace(/[^A-Za-z0-9_.-]/g, '').toLowerCase(); }
function sanitEt(s) { return String(s || '').substring(0, 200); }

function resolverPeriodo(req) {
  const dataDe = String(p(req, 'data_de', '')).trim();
  const dataAte = String(p(req, 'data_ate', '')).trim();
  let sinceIso, untilIso;
  if (dataDe || dataAte) {
    sinceIso = dataDe ? new Date(dataDe + 'T00:00:00.000Z').toISOString() : new Date('2020-01-01T00:00:00.000Z').toISOString();
    untilIso = dataAte ? new Date(dataAte + 'T23:59:59.999Z').toISOString() : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  } else {
    const periodoDias = Math.max(1, Math.min(90, Number(p(req, 'periodo', 7)) || 7));
    sinceIso = new Date(Date.now() - periodoDias * 24 * 60 * 60 * 1000).toISOString();
    untilIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  return { sinceIso, untilIso };
}

export default async function gestaoRoutes(fastify) {
  // ===== /webhook/chat-gestao-metricas =====
  const metricas = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const { sinceIso, untilIso } = resolverPeriodo(req);
    const atd = sanitAtd(p(req, 'atendente', ''));
    const etq = sanitEt(p(req, 'etiqueta', ''));
    try {
      const sql = `
WITH periodo AS (
  SELECT $1::timestamptz AS since_ts, $2::timestamptz AS until_ts
),
consultor AS (SELECT $3::text AS atd),
etiqueta_f AS (SELECT $4::text AS et),
msgs_periodo_all AS (
  SELECT m.* FROM chat_mensagens m, periodo p, etiqueta_f ef
  WHERE m.timestamp >= p.since_ts AND m.timestamp <= p.until_ts
    AND (ef.et = '' OR EXISTS (
      SELECT 1 FROM chat_conversa_etiquetas ce
      WHERE ce.conta_id = m.conta_id AND ce.telefone = m.telefone AND ce.etiqueta = ef.et
    ))
),
contatos_consultor AS (
  SELECT DISTINCT conta_id, telefone FROM msgs_periodo_all
  WHERE direcao='out'
    AND atendente NOT IN ('sistema','ia_followup','triagem_ia')
    AND atendente NOT LIKE 'disparo%'
    AND ((SELECT atd FROM consultor) = '' OR LOWER(atendente) = (SELECT atd FROM consultor))
),
msgs_periodo AS (
  SELECT m.* FROM msgs_periodo_all m
  WHERE (SELECT atd FROM consultor) = ''
     OR EXISTS (SELECT 1 FROM contatos_consultor c WHERE c.conta_id=m.conta_id AND c.telefone=m.telefone)
),
tempos AS (
  SELECT m_in.conta_id, m_in.telefone, m_in.timestamp AS in_ts,
         MIN(m_out.timestamp) AS resp_ts,
         MIN(m_out.atendente) AS atendente
  FROM msgs_periodo m_in
  LEFT JOIN msgs_periodo m_out
    ON m_out.conta_id = m_in.conta_id AND m_out.telefone = m_in.telefone
    AND m_out.direcao = 'out' AND m_out.timestamp > m_in.timestamp
    AND m_out.timestamp < m_in.timestamp + INTERVAL '2 hours'
    AND m_out.atendente NOT IN ('sistema','ia_followup','triagem_ia')
    AND m_out.atendente NOT LIKE 'disparo%'
    AND ((SELECT atd FROM consultor) = '' OR LOWER(m_out.atendente) = (SELECT atd FROM consultor))
  WHERE m_in.direcao = 'in'
    AND NOT EXISTS (
      SELECT 1 FROM chat_mensagens m_prev
      WHERE m_prev.conta_id = m_in.conta_id AND m_prev.telefone = m_in.telefone
        AND m_prev.direcao = 'out'
        AND m_prev.timestamp BETWEEN m_in.timestamp - INTERVAL '30 min' AND m_in.timestamp
    )
  GROUP BY m_in.conta_id, m_in.telefone, m_in.timestamp
),
tempos_ok AS (SELECT * FROM tempos WHERE resp_ts IS NOT NULL AND atendente IS NOT NULL),
abordados AS (
  SELECT conta_id, telefone,
         MIN(timestamp) AS primeira_out_ts,
         (ARRAY_AGG(atendente ORDER BY timestamp))[1] AS primeiro_atendente
  FROM msgs_periodo
  WHERE direcao='out'
    AND atendente NOT IN ('sistema','ia_followup','triagem_ia')
    AND ((SELECT atd FROM consultor) = '' OR LOWER(atendente) = (SELECT atd FROM consultor))
  GROUP BY conta_id, telefone
),
responderam AS (
  SELECT a.conta_id, a.telefone, a.primeiro_atendente,
         (SELECT MIN(m.timestamp) FROM chat_mensagens m
          WHERE m.conta_id=a.conta_id AND m.telefone=a.telefone
            AND m.direcao='in' AND m.timestamp > a.primeira_out_ts) AS resposta_ts
  FROM abordados a
),
finalizadas_periodo AS (
  SELECT cd.conta_id, cd.telefone, cd.atendente, cd.motivo_fechamento, cd.finalizada_em,
         mf.tipo AS motivo_tipo, mf.nome AS motivo_nome, mf.cor AS motivo_cor
  FROM chat_conversa_dono cd
  LEFT JOIN chat_motivos_fechamento mf ON mf.codigo = cd.motivo_fechamento
  WHERE cd.finalizada = true
    AND cd.finalizada_em >= (SELECT since_ts FROM periodo)
    AND cd.finalizada_em <= (SELECT until_ts FROM periodo)
    AND ((SELECT atd FROM consultor) = '' OR LOWER(cd.atendente) = (SELECT atd FROM consultor))
    AND ((SELECT et FROM etiqueta_f) = '' OR EXISTS (
      SELECT 1 FROM chat_conversa_etiquetas ce
      WHERE ce.conta_id = cd.conta_id AND ce.telefone = cd.telefone AND ce.etiqueta = (SELECT et FROM etiqueta_f)
    ))
),
conversas_periodo AS (SELECT DISTINCT conta_id, telefone FROM msgs_periodo),
conversas_atribuidas AS (
  SELECT cp.conta_id, cp.telefone FROM conversas_periodo cp
  JOIN chat_conversa_dono cd ON cd.conta_id=cp.conta_id AND cd.telefone=cp.telefone
  WHERE cd.atendente <> ''
    AND LOWER(cd.atendente) NOT IN ('triagem_ia','ia_followup','sistema')
    AND cd.atendente NOT LIKE 'disparo%'
)
SELECT json_build_object(
  'total_msgs_in',   (SELECT count(*) FROM msgs_periodo WHERE direcao='in'),
  'total_msgs_out',  (SELECT count(*) FROM msgs_periodo WHERE direcao='out'
                       AND ((SELECT atd FROM consultor) = '' OR LOWER(atendente) = (SELECT atd FROM consultor))),
  'total_msgs_triagem', (SELECT count(*) FROM msgs_periodo WHERE direcao='out' AND atendente='triagem_ia'),
  'total_disparos_sem_resposta', (
    SELECT count(*) FROM (
      SELECT DISTINCT ON (conta_id, telefone) conta_id, telefone, timestamp AS primeiro_disparo_ts
      FROM msgs_periodo
      WHERE direcao='out' AND atendente LIKE 'disparo%'
      ORDER BY conta_id, telefone, timestamp ASC
    ) d
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_mensagens m
      WHERE m.conta_id = d.conta_id AND m.telefone = d.telefone
        AND m.direcao = 'in' AND m.timestamp >= d.primeiro_disparo_ts
    )
  ),
  'total_disparos_contatos', (
    SELECT COUNT(DISTINCT (conta_id, telefone)) FROM msgs_periodo
    WHERE direcao='out' AND atendente LIKE 'disparo%'
  ),
  'total_conversas', (SELECT count(*) FROM conversas_atribuidas),
  'total_conversas_abertas', (
    SELECT count(*) FROM conversas_atribuidas ca
    JOIN chat_conversa_dono cd ON cd.conta_id=ca.conta_id AND cd.telefone=ca.telefone
    WHERE COALESCE(cd.finalizada,false) = false
  ),
  'tempo_medio_resp_seg', (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resp_ts - in_ts))),0)::int FROM tempos_ok),
  'tempo_median_resp_seg', (SELECT COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resp_ts - in_ts))),0)::int FROM tempos_ok),
  'total_abordados',  (SELECT count(*) FROM abordados),
  'total_responderam',(SELECT count(*) FROM responderam WHERE resposta_ts IS NOT NULL),
  'taxa_resposta_pct',(SELECT CASE WHEN count(*)>0 THEN ROUND(100.0 * count(*) FILTER (WHERE resposta_ts IS NOT NULL) / count(*), 1) ELSE 0 END FROM responderam),
  'total_matriculas', (SELECT count(*) FROM finalizadas_periodo WHERE motivo_tipo='ganho'),
  'total_finalizadas',(SELECT count(*) FROM finalizadas_periodo),
  'taxa_conversao_pct',(SELECT CASE WHEN (SELECT count(*) FROM conversas_atribuidas)>0 THEN ROUND(100.0 * (SELECT count(*) FROM finalizadas_periodo WHERE motivo_tipo='ganho') / (SELECT count(*) FROM conversas_atribuidas), 1) ELSE 0 END),
  'motivos_dist', (
    SELECT COALESCE(json_agg(x ORDER BY total DESC), '[]'::json) FROM (
      SELECT COALESCE(motivo_nome,'(sem motivo)') AS motivo, COALESCE(motivo_cor,'#94a3b8') AS cor,
             COALESCE(motivo_tipo,'perda') AS tipo, count(*) AS total
      FROM finalizadas_periodo
      GROUP BY motivo_nome, motivo_cor, motivo_tipo
    ) x
  ),
  'por_consultor', (
    SELECT COALESCE(json_agg(x ORDER BY volume DESC), '[]'::json) FROM (
      SELECT
        mn.atd AS atendente,
        COUNT(DISTINCT (mn.conta_id, mn.telefone)) AS volume,
        COUNT(*) AS msgs_enviadas,
        (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resp_ts - in_ts))),0)::int FROM tempos_ok t WHERE LOWER(t.atendente) = mn.atd) AS tempo_medio_seg,
        (SELECT count(*) FROM responderam r WHERE LOWER(r.primeiro_atendente) = mn.atd) AS abordados,
        (SELECT count(*) FROM responderam r WHERE LOWER(r.primeiro_atendente) = mn.atd AND r.resposta_ts IS NOT NULL) AS responderam,
        (SELECT CASE WHEN count(*)>0 THEN ROUND(100.0 * count(*) FILTER (WHERE resposta_ts IS NOT NULL) / count(*), 1) ELSE 0 END FROM responderam r WHERE LOWER(r.primeiro_atendente) = mn.atd) AS taxa_pct,
        (SELECT count(*) FROM finalizadas_periodo f WHERE LOWER(f.atendente) = mn.atd AND f.motivo_tipo='ganho') AS matriculas
      FROM (
        SELECT LOWER(m.atendente) AS atd, m.conta_id, m.telefone
        FROM msgs_periodo m
        WHERE m.direcao='out'
          AND m.atendente NOT IN ('sistema','ia_followup','triagem_ia')
          AND m.atendente NOT LIKE 'disparo%'
          AND ((SELECT atd FROM consultor) = '' OR LOWER(m.atendente) = (SELECT atd FROM consultor))
      ) mn
      GROUP BY mn.atd
    ) x
  ),
  'por_dia', (
    SELECT COALESCE(json_agg(x ORDER BY dia), '[]'::json) FROM (
      SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS dia,
             COUNT(*) FILTER (WHERE direcao='in') AS in_count,
             COUNT(*) FILTER (WHERE direcao='out') AS out_count
      FROM msgs_periodo
      GROUP BY 1
    ) x
  ),
  'triagem', (
    SELECT json_build_object(
      'iniciadas', COUNT(*),
      'concluidas', COUNT(*) FILTER (WHERE status='concluida'),
      'ativas', COUNT(*) FILTER (WHERE status='ativa'),
      'abandonadas', COUNT(*) FILTER (WHERE status='abandonada'),
      'canceladas', COUNT(*) FILTER (WHERE status IN ('cancelada','desativada_manual')),
      'taxa_conclusao_pct', CASE WHEN COUNT(*)>0 THEN ROUND(100.0 * COUNT(*) FILTER (WHERE status='concluida') / COUNT(*), 1) ELSE 0 END,
      'tempo_medio_min', COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (concluida_em - iniciada_em))/60) FILTER (WHERE status='concluida'), 1), 0)
    )
    FROM chat_triagem_sessoes ts, periodo p
    WHERE ts.iniciada_em >= p.since_ts AND ts.iniciada_em <= p.until_ts
      AND ((SELECT atd FROM consultor) = ''
           OR EXISTS (SELECT 1 FROM contatos_consultor c WHERE c.conta_id=ts.conta_id AND c.telefone=ts.telefone))
  )
) AS metricas`;
      const r = await query(sql, [sinceIso, untilIso, atd, etq]);
      const m = (r.rows[0] && r.rows[0].metricas) || {};
      return { ok: true, metricas: m };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.get('/webhook/chat-gestao-metricas', metricas);
  fastify.post('/webhook/chat-gestao-metricas', metricas);

  // ===== /webhook/chat-gestao-lista-conversas =====
  const listaConversas = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const periodoDias = Math.max(1, Math.min(90, Number(p(req, 'periodo', 7)) || 7));
    const atendente = String(p(req, 'atendente', '')).trim();
    const sinceIso = new Date(Date.now() - periodoDias * 24 * 60 * 60 * 1000).toISOString();
    try {
      const sql = `
SELECT m.conta_id, m.telefone,
  COALESCE(NULLIF(m.nome_contato,''),'Sem nome') AS nome,
  MAX(m.timestamp) AS ultima_ts,
  COUNT(*) AS total_msgs,
  COUNT(*) FILTER (WHERE m.direcao='out') AS out_count,
  COUNT(*) FILTER (WHERE m.direcao='in') AS in_count,
  (SELECT texto FROM chat_mensagens m2
   WHERE m2.conta_id=m.conta_id AND m2.telefone=m.telefone
   ORDER BY timestamp DESC LIMIT 1) AS ultima_msg,
  (SELECT string_agg(DISTINCT atendente, ', ') FROM chat_mensagens m3
   WHERE m3.conta_id=m.conta_id AND m3.telefone=m.telefone
     AND direcao='out' AND atendente NOT IN ('sistema','ia_followup','triagem_ia')
     AND atendente NOT LIKE 'disparo%') AS atendentes_str
FROM chat_mensagens m
WHERE m.timestamp >= $1::timestamptz
  AND ($2::text = '' OR EXISTS (
    SELECT 1 FROM chat_mensagens mx
    WHERE mx.conta_id=m.conta_id AND mx.telefone=m.telefone
      AND mx.direcao='out' AND mx.atendente=$2::text
      AND mx.timestamp >= $1::timestamptz
  ))
GROUP BY m.conta_id, m.telefone
ORDER BY ultima_ts DESC
LIMIT 100`;
      const r = await query(sql, [sinceIso, atendente]);
      return { ok: true, conversas: r.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.get('/webhook/chat-gestao-lista-conversas', listaConversas);
  fastify.post('/webhook/chat-gestao-lista-conversas', listaConversas);

  // ===== /webhook/chat-gestao-analise-ia (Gemini) =====
  const analiseIA = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
    if (!GEMINI_KEY) return reply.code(500).send({ ok: false, erro: 'GEMINI_API_KEY nao configurada no backend' });

    const b = req.body || {};
    const periodoDias = Math.max(1, Math.min(30, Number(b.periodo || 7)));
    const sinceIso = new Date(Date.now() - periodoDias * 24 * 60 * 60 * 1000).toISOString();
    const convsReq = Array.isArray(b.conversas) ? b.conversas.slice(0, 15) : [];

    try {
      let conversas = [];
      if (convsReq.length) {
        const condicoes = convsReq.map((_, i) => `(conta_id=$${2 + i * 2} AND telefone=$${3 + i * 2})`).join(' OR ');
        const params = [sinceIso];
        for (const c of convsReq) { params.push(String(c.conta_id || ''), String(c.telefone || '')); }
        const sql = `
SELECT conta_id, telefone,
  (SELECT json_agg(json_build_object('d', m.direcao, 't', COALESCE(m.texto,'['||m.tipo||']'), 'ts', m.timestamp, 'atd', m.atendente) ORDER BY m.timestamp)
   FROM chat_mensagens m
   WHERE m.conta_id=c.conta_id AND m.telefone=c.telefone
     AND m.timestamp >= $1::timestamptz
  ) AS msgs
FROM (SELECT DISTINCT conta_id, telefone FROM chat_mensagens WHERE ${condicoes}) c`;
        const r = await query(sql, params);
        conversas = r.rows.filter(x => x.conta_id);
      } else {
        const atendente = String(b.atendente || '').trim();
        const sql = `
WITH conversas_amostra AS (
  SELECT conta_id, telefone, MAX(timestamp) AS ultima_ts
  FROM chat_mensagens
  WHERE timestamp >= $1::timestamptz
    AND direcao='out'
    AND ($2::text = '' OR atendente = $2::text)
    AND atendente NOT IN ('sistema','ia_followup','triagem_ia')
    AND atendente NOT LIKE 'disparo%'
  GROUP BY conta_id, telefone
  ORDER BY ultima_ts DESC LIMIT 15
)
SELECT c.conta_id, c.telefone,
  (SELECT json_agg(json_build_object('d', m.direcao, 't', COALESCE(m.texto,'['||m.tipo||']'), 'ts', m.timestamp, 'atd', m.atendente) ORDER BY m.timestamp)
   FROM chat_mensagens m
   WHERE m.conta_id=c.conta_id AND m.telefone=c.telefone
     AND m.timestamp >= $1::timestamptz
  ) AS msgs
FROM conversas_amostra c`;
        const r = await query(sql, [sinceIso, atendente]);
        conversas = r.rows.filter(x => x.conta_id);
      }

      if (!conversas.length) {
        return { ok: true, total: 0, analisadas: 0, analise: { resumo_geral: 'Nenhuma conversa no periodo pra analisar.', pontos_fortes: [], pontos_melhorar: [], score_geral: 0, insights: [] } };
      }

      const amostra = conversas.slice(0, 10).map((c, idx) => {
        const msgs = (c.msgs || []).slice(-20);
        const linhas = msgs.map(m => `[${m.d === 'in' ? 'Cliente' : m.atd || 'Consultor'}]: ${(m.t || '').substring(0, 200)}`).join('\n');
        return `\n--- CONVERSA ${idx + 1} (${c.telefone}) ---\n${linhas}`;
      }).join('\n');

      const prompt = `Voce eh um analista de atendimento comercial da UniFECAF. Analise as ${Math.min(conversas.length, 10)} conversas de WhatsApp abaixo e devolva um relatorio em JSON com esta estrutura EXATA (sem markdown, sem comentario):

{
  "resumo_geral": "1-2 paragrafos avaliando o padrao geral do atendimento",
  "pontos_fortes": ["ponto 1", "ponto 2", "ponto 3"],
  "pontos_melhorar": ["ponto 1", "ponto 2", "ponto 3"],
  "score_geral": 7,
  "insights": ["insight 1 acionavel", "insight 2 acionavel"]
}

Avalie: qualidade da resposta, tom, agilidade percebida, aderencia a script de vendas, uso de perguntas abertas, personalizacao, conclusao (se cliente foi encaminhado ou fechou negocio). Score de 0 a 10.

CONVERSAS:
${amostra}`;

      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(GEMINI_KEY);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1500 } }),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      const jr = await resp.json();
      const txt = ((jr && jr.candidates && jr.candidates[0] && jr.candidates[0].content && jr.candidates[0].content.parts && jr.candidates[0].content.parts[0] && jr.candidates[0].content.parts[0].text) || '').trim();
      const m = txt.match(/\{[\s\S]*\}/);
      let parsed = {};
      if (m) { try { parsed = JSON.parse(m[0]); } catch (_) { } }
      if (!parsed.resumo_geral) {
        return { ok: false, erro: 'IA retornou formato invalido', bruto: txt.substring(0, 500) };
      }
      return { ok: true, total: conversas.length, analisadas: Math.min(conversas.length, 10), analise: parsed };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.post('/webhook/chat-gestao-analise-ia', analiseIA);

  // ===== /webhook/chat-gestao-detalhes =====
  const detalhes = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const TIPOS_OK = ['conversas_atendidas', 'matriculas', 'finalizadas', 'sem_resposta', 'em_triagem', 'disparos_sem_resposta'];
    const tipo = String(p(req, 'tipo', '')).toLowerCase();
    if (!TIPOS_OK.includes(tipo)) return reply.code(400).send({ ok: false, erro: 'tipo invalido. use: ' + TIPOS_OK.join(', ') });
    const { sinceIso, untilIso } = resolverPeriodo(req);
    const conta_f = String(p(req, 'conta_id', '')).replace(/[^A-Za-z0-9_.-]/g, '');
    const atd_f = sanitAtd(p(req, 'atendente', ''));
    const etq_f = sanitEt(p(req, 'etiqueta', ''));

    try {
      const sql = `
WITH filtros AS (
  SELECT $1::text AS tipo,
         $2::text AS conta_f,
         $3::text AS atd_f,
         $4::text AS etq_f,
         $5::timestamptz AS since_ts,
         $6::timestamptz AS until_ts
),
nomes AS (
  SELECT DISTINCT ON (m.conta_id, m.telefone) m.conta_id, m.telefone, m.nome_contato
  FROM chat_mensagens m
  WHERE m.nome_contato IS NOT NULL AND m.nome_contato <> ''
  ORDER BY m.conta_id, m.telefone, m.timestamp DESC
),
base AS (
  SELECT DISTINCT cd.conta_id, cd.telefone,
         cd.atendente AS dono, cd.atribuido_em AS ordem_ts,
         NULL::text AS motivo_nome, NULL::text AS motivo_tipo
  FROM chat_conversa_dono cd, filtros f
  WHERE f.tipo = 'conversas_atendidas'
    AND cd.atendente <> ''
    AND LOWER(cd.atendente) NOT IN ('sistema','ia_followup','triagem_ia')
    AND cd.atendente NOT LIKE 'disparo%'
    AND COALESCE(cd.finalizada, false) = false
    AND (f.conta_f = '' OR cd.conta_id = f.conta_f)
    AND (f.atd_f = '' OR LOWER(cd.atendente) = f.atd_f)
    AND EXISTS (SELECT 1 FROM chat_mensagens mm WHERE mm.conta_id=cd.conta_id AND mm.telefone=cd.telefone AND mm.timestamp BETWEEN f.since_ts AND f.until_ts)
    AND (f.etq_f = '' OR EXISTS (SELECT 1 FROM chat_conversa_etiquetas ce WHERE ce.conta_id=cd.conta_id AND ce.telefone=cd.telefone AND ce.etiqueta=f.etq_f))

  UNION ALL

  SELECT DISTINCT cd.conta_id, cd.telefone,
         cd.atendente AS dono, cd.finalizada_em AS ordem_ts,
         mf.nome AS motivo_nome, mf.tipo AS motivo_tipo
  FROM chat_conversa_dono cd
  JOIN chat_motivos_fechamento mf ON mf.codigo = cd.motivo_fechamento,
       filtros f
  WHERE f.tipo = 'matriculas'
    AND cd.finalizada = true
    AND mf.tipo = 'ganho'
    AND cd.finalizada_em BETWEEN f.since_ts AND f.until_ts
    AND (f.conta_f = '' OR cd.conta_id = f.conta_f)
    AND (f.atd_f = '' OR LOWER(cd.atendente) = f.atd_f)
    AND (f.etq_f = '' OR EXISTS (SELECT 1 FROM chat_conversa_etiquetas ce WHERE ce.conta_id=cd.conta_id AND ce.telefone=cd.telefone AND ce.etiqueta=f.etq_f))

  UNION ALL

  SELECT DISTINCT cd.conta_id, cd.telefone,
         cd.atendente AS dono, cd.finalizada_em AS ordem_ts,
         mf.nome AS motivo_nome, mf.tipo AS motivo_tipo
  FROM chat_conversa_dono cd
  LEFT JOIN chat_motivos_fechamento mf ON mf.codigo = cd.motivo_fechamento,
       filtros f
  WHERE f.tipo = 'finalizadas'
    AND cd.finalizada = true
    AND cd.finalizada_em BETWEEN f.since_ts AND f.until_ts
    AND (f.conta_f = '' OR cd.conta_id = f.conta_f)
    AND (f.atd_f = '' OR LOWER(cd.atendente) = f.atd_f)
    AND (f.etq_f = '' OR EXISTS (SELECT 1 FROM chat_conversa_etiquetas ce WHERE ce.conta_id=cd.conta_id AND ce.telefone=cd.telefone AND ce.etiqueta=f.etq_f))

  UNION ALL

  SELECT DISTINCT abd.conta_id, abd.telefone,
         abd.atendente AS dono, abd.primeira_out AS ordem_ts,
         NULL::text AS motivo_nome, NULL::text AS motivo_tipo
  FROM (
    SELECT m.conta_id, m.telefone, MIN(m.timestamp) AS primeira_out,
           (ARRAY_AGG(m.atendente ORDER BY m.timestamp))[1] AS atendente
    FROM chat_mensagens m, filtros f
    WHERE f.tipo = 'sem_resposta'
      AND m.direcao='out'
      AND m.timestamp BETWEEN f.since_ts AND f.until_ts
      AND m.atendente NOT IN ('sistema','ia_followup','triagem_ia')
      AND m.atendente NOT LIKE 'disparo%'
      AND (f.conta_f = '' OR m.conta_id = f.conta_f)
      AND (f.atd_f = '' OR LOWER(m.atendente) = f.atd_f)
    GROUP BY m.conta_id, m.telefone
  ) abd
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_mensagens min
    WHERE min.conta_id=abd.conta_id AND min.telefone=abd.telefone
      AND min.direcao='in' AND min.timestamp > abd.primeira_out
  )

  UNION ALL

  SELECT DISTINCT ts.conta_id, ts.telefone,
         'triagem_ia' AS dono, ts.iniciada_em AS ordem_ts,
         NULL::text AS motivo_nome, NULL::text AS motivo_tipo
  FROM chat_triagem_sessoes ts, filtros f
  WHERE f.tipo = 'em_triagem'
    AND ts.status = 'ativa'
    AND (f.conta_f = '' OR ts.conta_id = f.conta_f)

  UNION ALL

  SELECT DISTINCT dsp.conta_id, dsp.telefone,
         'disparo' AS dono, dsp.primeiro_disp AS ordem_ts,
         NULL::text AS motivo_nome, NULL::text AS motivo_tipo
  FROM (
    SELECT DISTINCT ON (m.conta_id, m.telefone) m.conta_id, m.telefone,
           m.timestamp AS primeiro_disp
    FROM chat_mensagens m, filtros f
    WHERE f.tipo = 'disparos_sem_resposta'
      AND m.direcao='out' AND m.atendente LIKE 'disparo%'
      AND m.timestamp BETWEEN f.since_ts AND f.until_ts
      AND (f.conta_f = '' OR m.conta_id = f.conta_f)
    ORDER BY m.conta_id, m.telefone, m.timestamp ASC
  ) dsp
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_mensagens min
    WHERE min.conta_id=dsp.conta_id AND min.telefone=dsp.telefone
      AND min.direcao='in' AND min.timestamp >= dsp.primeiro_disp
  )
)
SELECT
  b.conta_id,
  b.telefone,
  COALESCE(cc.nome, n.nome_contato, b.telefone) AS nome,
  b.dono AS consultor,
  b.ordem_ts,
  b.motivo_nome,
  b.motivo_tipo,
  (SELECT string_agg(etiqueta, ', ' ORDER BY etiqueta) FROM chat_conversa_etiquetas ce
   WHERE ce.conta_id=b.conta_id AND ce.telefone=b.telefone) AS etiquetas
FROM base b
LEFT JOIN chat_contatos_custom cc ON cc.conta_id=b.conta_id AND cc.telefone=b.telefone
LEFT JOIN nomes n ON n.conta_id=b.conta_id AND n.telefone=b.telefone
ORDER BY b.ordem_ts DESC NULLS LAST
LIMIT 5000`;
      const r = await query(sql, [tipo, conta_f, atd_f, etq_f, sinceIso, untilIso]);
      return { ok: true, total: r.rows.length, rows: r.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  };
  fastify.get('/webhook/chat-gestao-detalhes', detalhes);
  fastify.post('/webhook/chat-gestao-detalhes', detalhes);
}
