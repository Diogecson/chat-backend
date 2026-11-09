import { query } from '../services/db.js';
import { hasDb, config } from '../config.js';

const SQL_CONVERSAS = `
WITH ultimas AS (
  SELECT DISTINCT ON (conta_id, telefone)
    conta_id, telefone, nome_contato, texto, tipo, timestamp, direcao, atendente
  FROM chat_mensagens
  WHERE ($1 = '__all__' OR conta_id = $1)
  ORDER BY conta_id, telefone, timestamp DESC
),
janelas AS (
  SELECT conta_id, telefone, MAX(timestamp) AS ultima_in
  FROM chat_mensagens
  WHERE direcao = 'in' AND ($1 = '__all__' OR conta_id = $1)
  GROUP BY conta_id, telefone
),
nomes AS (
  SELECT DISTINCT ON (conta_id, telefone) conta_id, telefone, nome_contato
  FROM chat_mensagens
  WHERE nome_contato IS NOT NULL AND nome_contato <> '' AND ($1 = '__all__' OR conta_id = $1)
  ORDER BY conta_id, telefone, timestamp DESC
),
etiquetas_agg AS (
  SELECT conta_id, telefone, array_agg(DISTINCT etiqueta) AS etiquetas
  FROM chat_conversa_etiquetas
  WHERE ($1 = '__all__' OR conta_id = $1)
  GROUP BY conta_id, telefone
),
triagem_ativa AS (
  SELECT DISTINCT conta_id, telefone FROM chat_triagem_sessoes
  WHERE status = 'ativa' AND ($1 = '__all__' OR conta_id = $1)
),
base AS (
  SELECT
    u.conta_id, u.telefone,
    COALESCE(cc.nome, n.nome_contato, u.nome_contato, '') AS nome_contato,
    COALESCE(NULLIF(u.texto,''), u.tipo, '') AS ultima_msg,
    u.timestamp AS ultima_hora,
    CASE WHEN u.direcao='out' AND LOWER(COALESCE(u.atendente,'')) IN ('triagem_ia','ia_followup') THEN 'in' ELSE u.direcao END AS ultima_direcao,
    j.ultima_in,
    COALESCE(cd.atendente, '') AS dono,
    COALESCE(cd.finalizada, false) AS finalizada,
    cd.finalizada_em,
    cd.motivo_fechamento,
    mf.tipo AS motivo_tipo, mf.nome AS motivo_nome, mf.cor AS motivo_cor,
    COALESCE(ea.etiquetas, '{}') AS etiquetas,
    (ta.conta_id IS NOT NULL) AS em_triagem
  FROM ultimas u
  LEFT JOIN janelas j USING (conta_id, telefone)
  LEFT JOIN nomes n USING (conta_id, telefone)
  LEFT JOIN chat_contatos_custom cc ON cc.conta_id=u.conta_id AND cc.telefone=u.telefone
  LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
  LEFT JOIN chat_motivos_fechamento mf ON mf.codigo = cd.motivo_fechamento
  LEFT JOIN etiquetas_agg ea ON ea.conta_id=u.conta_id AND ea.telefone=u.telefone
  LEFT JOIN triagem_ativa ta ON ta.conta_id=u.conta_id AND ta.telefone=u.telefone
  WHERE (
    $2 = 'SUPER'
    OR (
      ($11 = '__all__' OR $11 = '*' OR ($11 <> '__none__' AND $11 <> '' AND u.conta_id = ANY(string_to_array($11, ','))))
      AND (
        $2 = 'ADM'
        OR (cd.atendente <> '' AND LOWER(cd.atendente) = LOWER($3))
      )
    )
  )
),
base_ia AS (
  SELECT b.*, COALESCE(ias.ativa, false) AS ia_ativa
  FROM base b
  LEFT JOIN chat_ia_atendimento_state ias ON ias.conta_id=b.conta_id AND ias.telefone=b.telefone
),
filtrada AS (
  SELECT * FROM base_ia
  WHERE (
    $4 = '__all__'
    OR ($4 = 'minhas' AND LOWER(dono) = LOWER($3) AND finalizada = false)
    OR ($4 = 'sem_dono' AND (dono = '' OR dono IS NULL) AND finalizada = false)
    OR ($4 = 'todas' AND finalizada = false)
    OR ($4 = 'atendimentos' AND dono <> '' AND finalizada = false)
    OR ($4 = 'triagem' AND em_triagem = true AND finalizada = false)
    OR ($4 = 'aguardando' AND (dono = '' OR dono IS NULL) AND finalizada = false AND em_triagem = false)
    OR ($4 = 'finalizadas' AND finalizada = true)
    OR ($4 = 'matriculas' AND finalizada = true AND motivo_tipo = 'ganho')
    OR ($4 = 'ia_ativa' AND ia_ativa = true AND finalizada = false)
  )
  AND ultima_hora >= COALESCE(NULLIF($5, '__all__')::timestamptz, '-infinity'::timestamptz)
  AND ultima_hora <= COALESCE(NULLIF($6, '__all__')::timestamptz, 'infinity'::timestamptz)
  AND ($7 = '__all__' OR $7 = ANY(etiquetas))
  AND ($8 = '__all__' OR LOWER(dono) = LOWER($8))
)
SELECT
  (SELECT COUNT(*) FROM filtrada) AS total_filtrado,
  COALESCE(
    (SELECT json_agg(row_to_json(x)) FROM (
      SELECT (conta_id || '_' || telefone) AS id, * FROM filtrada ORDER BY ultima_hora DESC LIMIT $9::int OFFSET $10::int
    ) x),
    '[]'::json
  ) AS conversas,
  $9::int AS limit_usado, $10::int AS offset_usado
`;

const SQL_CONTADORES = `
WITH filtros AS (
  SELECT $1::text AS conta_id_f, LOWER($2::text) AS usuario_f, LOWER($3::text) AS filtro_dono_f,
         UPPER($4::text) AS role_f, $5::text AS contas_perm_f,
         NULLIF($6,'')::timestamptz AS since_ts, NULLIF($7,'')::timestamptz AS until_ts
),
conv_base AS (
  SELECT u.conta_id, u.telefone, u.ultima_hora,
         COALESCE(cd.atendente,'') AS dono,
         COALESCE(cd.finalizada, false) AS finalizada,
         COALESCE(cd.motivo_fechamento,'') AS motivo_fechamento
  FROM (
    SELECT DISTINCT ON (conta_id, telefone) conta_id, telefone, timestamp AS ultima_hora
    FROM chat_mensagens ORDER BY conta_id, telefone, timestamp DESC
  ) u
  LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
  WHERE ((SELECT conta_id_f FROM filtros) = '__all__' OR u.conta_id = (SELECT conta_id_f FROM filtros))
    AND ((SELECT since_ts FROM filtros) IS NULL OR u.ultima_hora >= (SELECT since_ts FROM filtros))
    AND ((SELECT until_ts FROM filtros) IS NULL OR u.ultima_hora <= (SELECT until_ts FROM filtros))
    AND (
      (SELECT role_f FROM filtros) = 'SUPER'
      OR (
        ((SELECT contas_perm_f FROM filtros) IN ('__all__','*')
         OR ((SELECT contas_perm_f FROM filtros) NOT IN ('__none__','') AND u.conta_id = ANY(string_to_array((SELECT contas_perm_f FROM filtros), ','))))
        AND (
          (SELECT role_f FROM filtros) = 'ADM'
          OR (COALESCE(cd.atendente,'') <> '' AND LOWER(COALESCE(cd.atendente,'')) = (SELECT usuario_f FROM filtros))
        )
      )
    )
),
triagem_ativas AS (SELECT DISTINCT conta_id, telefone FROM chat_triagem_sessoes WHERE status='ativa')
SELECT json_build_object(
  'todas',       (SELECT COUNT(*) FROM conv_base WHERE finalizada = false),
  'minhas',      (SELECT COUNT(*) FROM conv_base WHERE finalizada = false AND LOWER(dono) = (SELECT usuario_f FROM filtros)),
  'livres',      (SELECT COUNT(*) FROM conv_base WHERE finalizada = false AND dono = ''),
  'atendimentos',(SELECT COUNT(*) FROM conv_base WHERE finalizada = false AND dono <> '' AND LOWER(dono) NOT IN ('sistema','ia_followup','triagem_ia')),
  'finalizadas', (SELECT COUNT(*) FROM conv_base WHERE finalizada = true),
  'matriculas',  (SELECT COUNT(*) FROM conv_base cb JOIN chat_motivos_fechamento mf ON mf.codigo = cb.motivo_fechamento WHERE cb.finalizada = true AND mf.tipo = 'ganho'),
  'ia_ativa',    (SELECT COUNT(*) FROM conv_base cb JOIN chat_ia_atendimento_state ias ON ias.conta_id = cb.conta_id AND ias.telefone = cb.telefone WHERE ias.ativa = true AND cb.finalizada = false),
  'triagem',     (SELECT COUNT(*) FROM conv_base cb JOIN triagem_ativas ta ON ta.conta_id = cb.conta_id AND ta.telefone = cb.telefone WHERE cb.finalizada = false),
  'aplicou_filtro_dono', (SELECT filtro_dono_f <> '' FROM filtros),
  'minhas_por_dono', (SELECT COUNT(*) FROM conv_base cb, filtros f WHERE cb.finalizada = false AND f.filtro_dono_f <> '' AND LOWER(cb.dono) = f.filtro_dono_f)
) AS contadores
`;

// helper pra ler param do body (POST) OU querystring (GET)
function p(req, name, def = '__all__') {
  const v = (req.body && req.body[name]) ?? req.query?.[name];
  if (v == null || v === '') return def;
  return String(v);
}

// usuario: aceita 'usuario' OU 'actor' (chat.html usa actor)
function pUsuario(req) {
  const v = (req.body?.usuario ?? req.query?.usuario ?? req.body?.actor ?? req.query?.actor);
  return v ? String(v).toLowerCase() : '';
}

// role: normaliza CONSULTOR → USER, ADMIN → ADM; aceita qualquer caso
function pRole(req) {
  const v = (req.body?.role ?? req.query?.role ?? req.body?.papel ?? req.query?.papel) || 'USER';
  const r = String(v).toUpperCase();
  if (r === 'CONSULTOR' || r === 'CONSULTANT' || r === 'AGENT') return 'USER';
  if (r === 'ADMIN') return 'ADM';
  return r; // USER, ADM, SUPER
}

// Força conta_id se CONTA_FIXA setada (modo instância dedicada)
function forceConta(contaIdReq) {
  return config.contaFixa || contaIdReq || '__all__';
}

// Força contas_permitidas pra contaFixa se estiver em modo dedicado
function forceContasPermitidas(permReq) {
  if (config.contaFixa) return config.contaFixa;
  return permReq || '__all__';
}

export default async function conversasRoutes(fastify) {
  // Compatível com o chat.html atual (que chama /webhook/chat-conversas via POST)
  async function handleConversas(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
    const params = [
      forceConta(p(req, 'conta_id')),            // $1
      pRole(req),                                // $2
      pUsuario(req),                             // $3
      p(req, 'visao', '__all__'),                // $4
      p(req, 'desde', '__all__'),                // $5
      p(req, 'ate', '__all__'),                  // $6
      p(req, 'etiqueta', '__all__'),             // $7
      p(req, 'filtro_dono', '__all__'),          // $8
      parseInt(p(req, 'limit', '50')) || 50,     // $9
      parseInt(p(req, 'offset', '0')) || 0,      // $10
      forceContasPermitidas(p(req, 'contas_permitidas', '__all__')), // $11
    ];
    try {
      const res = await query(SQL_CONVERSAS, params);
      return res.rows[0] || { total_filtrado: 0, conversas: [], limit_usado: 50, offset_usado: 0 };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  }

  async function handleContadores(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
    const params = [
      forceConta(p(req, 'conta_id')),
      pUsuario(req),
      p(req, 'filtro_dono', ''),
      pRole(req),
      forceContasPermitidas(p(req, 'contas_permitidas', '__all__')),
      p(req, 'desde', ''),
      p(req, 'ate', ''),
    ];
    try {
      const res = await query(SQL_CONTADORES, params);
      const contadores = res.rows[0]?.contadores || {};
      return { ok: true, contadores };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  }

  // Rotas backend-nativas
  fastify.get('/api/conversas', handleConversas);
  fastify.post('/api/conversas', handleConversas);
  fastify.get('/api/contadores', handleContadores);
  fastify.post('/api/contadores', handleContadores);

  // === chat-conversas-delta ===
  // Devolve só as conversas (até 500) que mudaram desde $since (ultima mensagem ou mudança de dono)
  async function handleConversasDelta(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const conta_id = forceConta(p(req, 'conta_id', '__all__'));
    const role = pRole(req);
    const usuario = pUsuario(req);
    const since = p(req, 'since', new Date(Date.now() - 300000).toISOString());
    const contas_permitidas = forceContasPermitidas(p(req, 'contas_permitidas', '__all__'));
    const sql = `
      WITH mudou_msg AS (
        SELECT DISTINCT conta_id, telefone FROM chat_mensagens
        WHERE timestamp > $4::timestamptz AND ($1 = '__all__' OR conta_id = $1)
      ),
      mudou_fim AS (
        SELECT conta_id, telefone FROM chat_conversa_dono
        WHERE (finalizada_em > $4::timestamptz OR atribuido_em > $4::timestamptz)
          AND ($1 = '__all__' OR conta_id = $1)
      ),
      mudou AS (SELECT conta_id, telefone FROM mudou_msg UNION SELECT conta_id, telefone FROM mudou_fim),
      ultimas AS (
        SELECT DISTINCT ON (m.conta_id, m.telefone)
          m.conta_id, m.telefone, m.nome_contato, m.texto, m.tipo, m.timestamp, m.direcao, m.atendente
        FROM chat_mensagens m
        INNER JOIN mudou md ON md.conta_id=m.conta_id AND md.telefone=m.telefone
        ORDER BY m.conta_id, m.telefone, m.timestamp DESC
      ),
      etiquetas_agg AS (
        SELECT e.conta_id, e.telefone, array_agg(DISTINCT e.etiqueta) AS etiquetas
        FROM chat_conversa_etiquetas e
        INNER JOIN mudou md ON md.conta_id=e.conta_id AND md.telefone=e.telefone
        GROUP BY e.conta_id, e.telefone
      ),
      triagem_ativa AS (
        SELECT DISTINCT t.conta_id, t.telefone FROM chat_triagem_sessoes t
        INNER JOIN mudou md ON md.conta_id=t.conta_id AND md.telefone=t.telefone
        WHERE t.status='ativa'
      )
      SELECT
        (u.conta_id || '_' || u.telefone) AS id,
        u.conta_id, u.telefone,
        COALESCE(cc.nome, u.nome_contato, '') AS nome_contato,
        COALESCE(NULLIF(u.texto,''), u.tipo, '') AS ultima_msg,
        u.timestamp AS ultima_hora,
        CASE WHEN u.direcao='out' AND LOWER(COALESCE(u.atendente,'')) IN ('triagem_ia','ia_followup') THEN 'in' ELSE u.direcao END AS ultima_direcao,
        COALESCE(cd.atendente, '') AS dono,
        COALESCE(cd.finalizada, false) AS finalizada,
        cd.motivo_fechamento,
        mf.tipo AS motivo_tipo, mf.nome AS motivo_nome, mf.cor AS motivo_cor,
        COALESCE(ea.etiquetas, '{}') AS etiquetas,
        (ta.conta_id IS NOT NULL) AS em_triagem,
        COALESCE(ias.ativa, false) AS ia_ativa
      FROM ultimas u
      LEFT JOIN chat_contatos_custom cc ON cc.conta_id=u.conta_id AND cc.telefone=u.telefone
      LEFT JOIN chat_conversa_dono cd ON cd.conta_id=u.conta_id AND cd.telefone=u.telefone
      LEFT JOIN chat_motivos_fechamento mf ON mf.codigo = cd.motivo_fechamento
      LEFT JOIN etiquetas_agg ea ON ea.conta_id=u.conta_id AND ea.telefone=u.telefone
      LEFT JOIN triagem_ativa ta ON ta.conta_id=u.conta_id AND ta.telefone=u.telefone
      LEFT JOIN chat_ia_atendimento_state ias ON ias.conta_id=u.conta_id AND ias.telefone=u.telefone
      WHERE (
        $2 = 'SUPER'
        OR ( ($5 = '__all__' OR $5 = '*' OR ($5 <> '__none__' AND $5 <> '' AND u.conta_id = ANY(string_to_array($5, ','))))
          AND ( $2 = 'ADM' OR (cd.atendente <> '' AND LOWER(cd.atendente) = LOWER($3)) ) )
      )
      ORDER BY u.timestamp DESC LIMIT 500`;
    try {
      const r = await query(sql, [conta_id, role, usuario, since, contas_permitidas]);
      return { ok: true, conversas: r.rows, now: new Date().toISOString() };
    } catch (err) { reply.code(500); return { ok: false, error: err.message }; }
  }
  fastify.get('/webhook/chat-conversas-delta', handleConversasDelta);
  fastify.post('/webhook/chat-conversas-delta', handleConversasDelta);
  fastify.get('/api/conversas-delta', handleConversasDelta);
  fastify.post('/api/conversas-delta', handleConversasDelta);

  // Aliases /webhook/* — interceptam ANTES do proxy pro n8n
  fastify.get('/webhook/chat-conversas', handleConversas);
  fastify.post('/webhook/chat-conversas', handleConversas);
  fastify.get('/webhook/chat-contadores', handleContadores);
  fastify.post('/webhook/chat-contadores', handleContadores);
}
