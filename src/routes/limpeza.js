// Limpeza em massa de conversas finalizadas:
// - dry_run: conta quantas conversas/mensagens cairiam na vassoura, sem apagar
// - sem dry_run: DELETE em transacao de chat_mensagens + chat_conversa_dono +
//   chat_conversa_etiquetas filtrado por finalizada=true AND finalizada_em antigo
// - Grava historico em chat_limpeza_log
// - Exige papel SUPER
// - Roda VACUUM ANALYZE no final (fora da transacao)
//
// Regras duras de seguranca (mesmo sendo SUPER):
// - dias_min >= 7 (nao deixa apagar algo muito recente)
// - so finalizada=true (nunca toca em conversa aberta)
// - fallback finalizada_em NULL -> usa ultima msg daquela conversa, pra
//   pegar finalizadas antigas que nao receberam carimbo (legado do n8n)

import { query, getPool } from '../services/db.js';
import { hasDb } from '../config.js';

function p(req, name, def = '') {
  const v = (req.body && req.body[name]) ?? req.query?.[name];
  if (v == null || v === '') return def;
  return String(v);
}

async function ensureLimpezaLog() {
  await query(`
    CREATE TABLE IF NOT EXISTS chat_limpeza_log (
      id BIGSERIAL PRIMARY KEY,
      usuario VARCHAR(80) NOT NULL,
      conta_id VARCHAR(80) DEFAULT '__all__',
      dias_min INT NOT NULL,
      conversas_apagadas INT NOT NULL DEFAULT 0,
      mensagens_apagadas INT NOT NULL DEFAULT 0,
      etiquetas_apagadas INT NOT NULL DEFAULT 0,
      vapo_logs_apagados INT NOT NULL DEFAULT 0,
      vacuum_ok BOOLEAN DEFAULT false,
      duracao_ms INT DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_limpeza_log_criado ON chat_limpeza_log(criado_em DESC)`).catch(() => {});
}

// CTE que seleciona as conversas candidatas (usada pelo preview e pelo delete)
// $1 = dias_min (int), $2 = conta_id ('__all__' ou codigo), $3 = limit (int) ou NULL
const SQL_CANDIDATAS = `
  WITH ult AS (
    SELECT conta_id, telefone, MAX(timestamp) AS ultima_msg_ts
    FROM chat_mensagens
    GROUP BY conta_id, telefone
  )
  SELECT cd.conta_id, cd.telefone, cd.finalizada_em, u.ultima_msg_ts,
         COALESCE(cd.finalizada_em, u.ultima_msg_ts) AS criterio_ts
  FROM chat_conversa_dono cd
  LEFT JOIN ult u ON u.conta_id = cd.conta_id AND u.telefone = cd.telefone
  WHERE cd.finalizada = true
    AND ($2 = '__all__' OR cd.conta_id = $2)
    AND COALESCE(cd.finalizada_em, u.ultima_msg_ts) IS NOT NULL
    AND COALESCE(cd.finalizada_em, u.ultima_msg_ts) < NOW() - ($1::int || ' days')::interval
`;

export default async function limpezaRoutes(fastify) {
  async function handle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });

    const usuario = p(req, 'usuario', '').toLowerCase();
    const papel = p(req, 'papel', p(req, 'role', 'USER')).toUpperCase();
    const dias_min = Math.max(7, parseInt(p(req, 'dias_min', '30'), 10) || 30);
    const conta_id = p(req, 'conta_id', '__all__');
    const dry_run_raw = p(req, 'dry_run', 'true');
    const dry_run = dry_run_raw === 'true' || dry_run_raw === true || dry_run_raw === '1';
    const rodar_vacuum = String(p(req, 'vacuum', 'true')).toLowerCase() === 'true';

    if (papel !== 'SUPER') {
      return reply.code(403).send({ ok: false, erro: 'apenas SUPER pode limpar em massa' });
    }
    if (!usuario) {
      return reply.code(400).send({ ok: false, erro: 'usuario obrigatorio' });
    }

    try {
      await ensureLimpezaLog();

      // Preview: contagem de conversas E mensagens que seriam apagadas
      const sqlPreview = `
        WITH cand AS (${SQL_CANDIDATAS})
        SELECT
          (SELECT COUNT(*) FROM cand)::int AS conversas,
          (SELECT COUNT(*) FROM chat_mensagens m
             WHERE EXISTS (SELECT 1 FROM cand c WHERE c.conta_id=m.conta_id AND c.telefone=m.telefone))::int AS mensagens,
          (SELECT COUNT(*) FROM chat_conversa_etiquetas e
             WHERE EXISTS (SELECT 1 FROM cand c WHERE c.conta_id=e.conta_id AND c.telefone=e.telefone))::int AS etiquetas
      `;
      const pv = await query(sqlPreview, [dias_min, conta_id]);
      const prev = pv.rows[0] || { conversas: 0, mensagens: 0, etiquetas: 0 };

      if (dry_run) {
        return {
          ok: true,
          dry_run: true,
          criterio: `finalizada=true e >${dias_min} dias sem atividade`,
          conta_id,
          conversas: prev.conversas,
          mensagens: prev.mensagens,
          etiquetas: prev.etiquetas,
        };
      }

      if (prev.conversas === 0) {
        return { ok: true, dry_run: false, apagadas: 0, msg: 'nada pra apagar com esse filtro' };
      }

      // EXECUTA: transacao atomica. Se qualquer passo der erro, nada apaga.
      const t0 = Date.now();
      const pool = getPool();
      const client = await pool.connect();
      let resultado = { conversas: 0, mensagens: 0, etiquetas: 0, vapo: 0 };
      try {
        await client.query('BEGIN');

        // 1) Marca pra apagar
        await client.query(`CREATE TEMP TABLE _cand ON COMMIT DROP AS ${SQL_CANDIDATAS}`, [dias_min, conta_id]);

        // 2) Apaga mensagens (maior volume)
        const rMsg = await client.query(`
          DELETE FROM chat_mensagens m
          USING _cand c
          WHERE c.conta_id = m.conta_id AND c.telefone = m.telefone
        `);
        resultado.mensagens = rMsg.rowCount || 0;

        // 3) Apaga etiquetas
        const rEt = await client.query(`
          DELETE FROM chat_conversa_etiquetas e
          USING _cand c
          WHERE c.conta_id = e.conta_id AND c.telefone = e.telefone
        `);
        resultado.etiquetas = rEt.rowCount || 0;

        // 4) Apaga logs do VAPO dessa conversa
        try {
          const rVapo = await client.query(`
            DELETE FROM chat_vapo_log v
            USING _cand c
            WHERE c.conta_id = v.conta_id AND c.telefone = v.telefone
          `);
          resultado.vapo = rVapo.rowCount || 0;
        } catch (_) { /* tabela pode nao existir ainda */ }

        // 5) Apaga dono da conversa (por ultimo, pra manter o filtro de candidatas valido)
        const rConv = await client.query(`
          DELETE FROM chat_conversa_dono d
          USING _cand c
          WHERE c.conta_id = d.conta_id AND c.telefone = d.telefone
        `);
        resultado.conversas = rConv.rowCount || 0;

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // 6) VACUUM ANALYZE (fora da transacao — nao pode rodar dentro de BEGIN).
      // Usa conexao dedicada e reseta timeout antes de devolver ao pool
      // pra nao contaminar outras queries.
      let vacuum_ok = false;
      if (rodar_vacuum) {
        const vacClient = await pool.connect();
        try {
          await vacClient.query(`SET LOCAL statement_timeout = '60s'`).catch(() => {});
          await vacClient.query(`VACUUM ANALYZE chat_mensagens`);
          await vacClient.query(`VACUUM ANALYZE chat_conversa_dono`);
          vacuum_ok = true;
        } catch (err) {
          fastify.log.warn(`[limpeza] vacuum falhou: ${err.message}`);
        } finally {
          await vacClient.query(`RESET statement_timeout`).catch(() => {});
          vacClient.release();
        }
      }

      const duracao = Date.now() - t0;

      // 7) Log
      await query(
        `INSERT INTO chat_limpeza_log
         (usuario, conta_id, dias_min, conversas_apagadas, mensagens_apagadas, etiquetas_apagadas, vapo_logs_apagados, vacuum_ok, duracao_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [usuario, conta_id, dias_min, resultado.conversas, resultado.mensagens, resultado.etiquetas, resultado.vapo, vacuum_ok, duracao]
      );

      fastify.log.info(`[limpeza] ${usuario} apagou ${resultado.conversas} conv / ${resultado.mensagens} msgs em ${duracao}ms`);

      return {
        ok: true,
        dry_run: false,
        dias_min,
        conta_id,
        apagadas: resultado,
        vacuum_ok,
        duracao_ms: duracao,
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  }

  fastify.post('/webhook/chat-limpar-finalizados', handle);
  fastify.get('/webhook/chat-limpar-finalizados', handle); // aceita GET pra debug

  // Historico das limpezas (ultimas 50)
  fastify.get('/webhook/chat-limpeza-historico', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    try {
      await ensureLimpezaLog();
      const r = await query(
        `SELECT id, usuario, conta_id, dias_min, conversas_apagadas, mensagens_apagadas,
                etiquetas_apagadas, vapo_logs_apagados, vacuum_ok, duracao_ms, criado_em
         FROM chat_limpeza_log
         ORDER BY criado_em DESC
         LIMIT 50`
      );
      return { ok: true, itens: r.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });

  // Estatisticas de banco pra exibir na tela (tamanho atual, qtd conversas por idade)
  fastify.get('/webhook/chat-limpeza-stats', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    try {
      const r = await query(`
        WITH ult AS (
          SELECT conta_id, telefone, MAX(timestamp) AS ultima_msg_ts
          FROM chat_mensagens
          GROUP BY conta_id, telefone
        ),
        base AS (
          SELECT cd.conta_id, cd.telefone, cd.finalizada,
                 COALESCE(cd.finalizada_em, u.ultima_msg_ts) AS criterio_ts
          FROM chat_conversa_dono cd
          LEFT JOIN ult u ON u.conta_id = cd.conta_id AND u.telefone = cd.telefone
        )
        SELECT
          (SELECT COUNT(*) FROM chat_mensagens)::int AS total_msgs,
          (SELECT COUNT(*) FROM base WHERE finalizada = true)::int AS total_finalizadas,
          (SELECT COUNT(*) FROM base WHERE COALESCE(finalizada, false) = false)::int AS total_abertas,
          (SELECT COUNT(*) FROM base WHERE finalizada = true
             AND criterio_ts < NOW() - INTERVAL '7 days')::int AS fin_mais_7d,
          (SELECT COUNT(*) FROM base WHERE finalizada = true
             AND criterio_ts < NOW() - INTERVAL '30 days')::int AS fin_mais_30d,
          (SELECT COUNT(*) FROM base WHERE finalizada = true
             AND criterio_ts < NOW() - INTERVAL '60 days')::int AS fin_mais_60d,
          (SELECT COUNT(*) FROM base WHERE finalizada = true
             AND criterio_ts < NOW() - INTERVAL '90 days')::int AS fin_mais_90d,
          pg_size_pretty(pg_total_relation_size('chat_mensagens')) AS tamanho_msgs,
          pg_size_pretty(pg_total_relation_size('chat_conversa_dono')) AS tamanho_conv,
          pg_size_pretty(pg_database_size(current_database())) AS tamanho_db
      `);
      return { ok: true, ...r.rows[0] };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });
}
