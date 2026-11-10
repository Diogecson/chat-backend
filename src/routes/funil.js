// /webhook/chat-funil — retorna conversas classificadas por temperatura (quente/morna/fria)
// e com cor de bolinha (verde=consultor aguarda cliente; vermelho=consultor devendo;
// amarelo=cliente aguarda e sem dono).
import { query } from '../services/db.js';
import { hasDb, config } from '../config.js';

function p(req, name, def = '__all__') {
  const v = (req.body && req.body[name]) ?? req.query?.[name];
  if (v == null || v === '') return def;
  return String(v);
}
function pUsuario(req) {
  const v = (req.body?.usuario ?? req.query?.usuario ?? req.body?.actor ?? req.query?.actor);
  return v ? String(v).toLowerCase() : '';
}
function pRole(req) {
  const v = (req.body?.role ?? req.query?.role ?? req.body?.papel ?? req.query?.papel) || 'USER';
  const r = String(v).toUpperCase();
  if (r === 'CONSULTOR' || r === 'CONSULTANT' || r === 'AGENT') return 'USER';
  if (r === 'ADMIN') return 'ADM';
  return r;
}
function forceConta(contaIdReq) { return config.contaFixa || contaIdReq || '__all__'; }
function forceContasPermitidas(permReq) {
  if (config.contaFixa) return config.contaFixa;
  return permReq || '__all__';
}

const SQL = `
WITH ultimas AS (
  SELECT DISTINCT ON (conta_id, telefone)
    conta_id, telefone, nome_contato, texto, tipo, timestamp, direcao, atendente
  FROM chat_mensagens
  WHERE ($1 = '__all__' OR conta_id = $1)
  ORDER BY conta_id, telefone, timestamp DESC
),
base AS (
  SELECT
    u.conta_id, u.telefone,
    COALESCE(cc.nome, u.nome_contato, '') AS nome_contato,
    COALESCE(NULLIF(u.texto,''), '[' || u.tipo || ']', '') AS ultima_msg,
    u.timestamp AS ultima_hora,
    CASE
      WHEN u.direcao = 'out' AND LOWER(COALESCE(u.atendente,'')) IN ('triagem_ia','ia_followup') THEN 'in'
      ELSE u.direcao
    END AS ultima_direcao,
    COALESCE(cd.atendente, '') AS dono,
    COALESCE(cd.finalizada, false) AS finalizada,
    EXTRACT(EPOCH FROM (NOW() - u.timestamp))/3600 AS horas_desde_ultima
  FROM ultimas u
  LEFT JOIN chat_contatos_custom cc ON cc.conta_id=u.conta_id AND cc.telefone=u.telefone
  LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
  WHERE COALESCE(cd.finalizada, false) = false
    AND (
      $2 = 'SUPER'
      OR (
        ($5 = '__all__' OR $5 = '*' OR ($5 <> '__none__' AND $5 <> '' AND u.conta_id = ANY(string_to_array($5, ','))))
        AND (
          $2 = 'ADM'
          OR (cd.atendente <> '' AND LOWER(cd.atendente) = LOWER($3))
        )
      )
    )
    AND ( $4 = '__all__' OR ($4 = 'minhas' AND LOWER(COALESCE(cd.atendente,'')) = LOWER($3)) )
)
SELECT
  (conta_id || '_' || telefone) AS id,
  conta_id, telefone, nome_contato, ultima_msg, ultima_hora, ultima_direcao, dono,
  ROUND(horas_desde_ultima::numeric, 2) AS horas_desde_ultima,
  CASE
    WHEN horas_desde_ultima < 6 THEN 'quente'
    WHEN horas_desde_ultima < 24 THEN 'morna'
    ELSE 'fria'
  END AS temperatura,
  CASE
    WHEN ultima_direcao = 'in' AND (dono = '' OR dono IS NULL) THEN 'amarelo'
    WHEN ultima_direcao = 'in' THEN 'vermelho'
    ELSE 'verde'
  END AS bolinha
FROM base
ORDER BY ultima_hora DESC
LIMIT 800
`;

export default async function funilRoutes(fastify) {
  async function handle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const params = [
      forceConta(p(req, 'conta_id')),                                    // $1
      pRole(req),                                                        // $2
      pUsuario(req),                                                     // $3
      p(req, 'visao', '__all__'),                                        // $4 ('__all__' | 'minhas')
      forceContasPermitidas(p(req, 'contas_permitidas', '__all__')),     // $5
    ];
    try {
      const r = await query(SQL, params);
      const rows = r.rows || [];
      const agrup = { quente: [], morna: [], fria: [] };
      for (const row of rows) {
        (agrup[row.temperatura] || agrup.fria).push(row);
      }
      return {
        ok: true,
        total: rows.length,
        quente: agrup.quente,
        morna: agrup.morna,
        fria: agrup.fria,
        now: new Date().toISOString(),
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  }
  fastify.get('/webhook/chat-funil', handle);
  fastify.post('/webhook/chat-funil', handle);
  fastify.get('/api/chat/funil', handle);
  fastify.post('/api/chat/funil', handle);

  // ===== Metricas de tempo de resposta por consultor =====
  // Pra cada par (msg_in cliente -> msg_out consultor seguinte) na mesma conversa,
  // calcula o delta. Ignora respostas que demoraram >12h (chat morreu e voltou).
  const SQL_METRICAS = `
WITH msgs AS (
  SELECT conta_id, telefone, direcao, LOWER(COALESCE(atendente,'')) AS atendente, timestamp,
    LAG(direcao) OVER (PARTITION BY conta_id, telefone ORDER BY timestamp) AS prev_dir,
    LAG(timestamp) OVER (PARTITION BY conta_id, telefone ORDER BY timestamp) AS prev_ts
  FROM chat_mensagens
  WHERE timestamp > NOW() - INTERVAL '7 days'
    AND ($1 = '__all__' OR conta_id = $1)
),
respostas AS (
  SELECT atendente,
    EXTRACT(EPOCH FROM (timestamp - prev_ts))/60 AS min_ate_resposta
  FROM msgs
  WHERE direcao = 'out'
    AND prev_dir = 'in'
    AND atendente <> ''
    AND atendente NOT IN ('triagem_ia','ia_followup','sistema','admin')
    AND (timestamp - prev_ts) BETWEEN INTERVAL '0 seconds' AND INTERVAL '12 hours'
)
SELECT atendente,
  COUNT(*)::int AS total_respostas,
  ROUND(AVG(min_ate_resposta)::numeric, 1)::float AS media_min,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY min_ate_resposta))::numeric, 1)::float AS mediana_min
FROM respostas
GROUP BY atendente
ORDER BY media_min ASC NULLS LAST
`;

  async function metricasHandle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const conta = forceConta(p(req, 'conta_id'));
    try {
      const r = await query(SQL_METRICAS, [conta]);
      return {
        ok: true,
        janela_dias: 7,
        metricas: r.rows || [],
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  }
  fastify.get('/webhook/chat-funil-metricas', metricasHandle);
  fastify.post('/webhook/chat-funil-metricas', metricasHandle);
}
