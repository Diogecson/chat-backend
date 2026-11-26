// Analises do chat — 3 relatorios:
// - Volume: bate-papos recebidos, contatos distintos, conversas transferidas
// - Tempos: primeira interacao, primeira resposta, conclusao, resolucao
// - Heatmap: distribuicao dia-da-semana × hora
//
// Todas as rotas aceitam ?de=YYYY-MM-DD&ate=YYYY-MM-DD ou ?periodo=hoje|ontem|7d|1m|3m
// Opcional: &conta_id=X&atendente=Y
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

function resolverPeriodo(q) {
  const periodo = String(q.periodo || '').toLowerCase();
  const agora = new Date();
  let de, ate;
  if (q.de && q.ate) {
    de = new Date(q.de + 'T00:00:00-03:00');
    ate = new Date(q.ate + 'T23:59:59-03:00');
  } else {
    switch (periodo) {
      case 'hoje':
        de = new Date(agora); de.setHours(0, 0, 0, 0);
        ate = new Date(agora); ate.setHours(23, 59, 59, 999);
        break;
      case 'ontem':
        de = new Date(agora); de.setDate(de.getDate() - 1); de.setHours(0, 0, 0, 0);
        ate = new Date(de); ate.setHours(23, 59, 59, 999);
        break;
      case '1m':
        de = new Date(agora); de.setDate(de.getDate() - 30); de.setHours(0, 0, 0, 0);
        ate = new Date(agora);
        break;
      case '3m':
        de = new Date(agora); de.setDate(de.getDate() - 90); de.setHours(0, 0, 0, 0);
        ate = new Date(agora);
        break;
      case '7d':
      default:
        de = new Date(agora); de.setDate(de.getDate() - 7); de.setHours(0, 0, 0, 0);
        ate = new Date(agora);
    }
  }
  return { de, ate };
}

function filtroConta(q, paramIdx, params) {
  const conta_id = q.conta_id ? String(q.conta_id) : '';
  if (!conta_id || conta_id === '__all__') return '';
  params.push(conta_id);
  return ` AND conta_id = $${paramIdx}`;
}

export default async function analisesRoutes(fastify) {

  // ===== VOLUME =====
  async function volume(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const { de, ate } = resolverPeriodo(req.query || {});
    const params = [de, ate];
    const whereConta = filtroConta(req.query, 3, params);

    // Serie temporal diaria
    const serie = await query(`
      WITH diario AS (
        SELECT DATE(timestamp AT TIME ZONE 'America/Sao_Paulo') AS dia,
               COUNT(*) FILTER (WHERE direcao='in') AS msgs_in,
               COUNT(*) FILTER (WHERE direcao='out') AS msgs_out,
               COUNT(DISTINCT (conta_id || '|' || telefone)) FILTER (WHERE direcao='in') AS conversas_in,
               COUNT(DISTINCT telefone) FILTER (WHERE direcao='in') AS contatos
        FROM chat_mensagens
        WHERE timestamp >= $1 AND timestamp <= $2 ${whereConta}
        GROUP BY dia
      )
      SELECT dia, msgs_in::int, msgs_out::int, conversas_in::int, contatos::int
      FROM diario ORDER BY dia ASC
    `, params);

    // Transferidas (via chat_vapo_log)
    const transfParams = [de, ate];
    const whereTransf = filtroConta(req.query, 3, transfParams);
    const transf = await query(`
      SELECT DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') AS dia, COUNT(*)::int AS total
      FROM chat_vapo_log
      WHERE criado_em >= $1 AND criado_em <= $2 ${whereTransf}
      GROUP BY dia ORDER BY dia ASC
    `, transfParams).catch(() => ({ rows: [] }));

    // Monta totais
    const totais = {
      batepapos_recebidos: serie.rows.reduce((a, r) => a + (r.conversas_in || 0), 0),
      contatos_distintos: serie.rows.reduce((a, r) => a + (r.contatos || 0), 0),
      conversas_transferidas: transf.rows.reduce((a, r) => a + (r.total || 0), 0),
      dias: serie.rows.length || 1,
    };
    totais.media_recebidos = (totais.batepapos_recebidos / totais.dias).toFixed(2);
    totais.media_contatos = (totais.contatos_distintos / totais.dias).toFixed(2);
    totais.media_transferidas = (totais.conversas_transferidas / totais.dias).toFixed(2);

    // Merge transferidas na serie
    const transfMap = new Map(transf.rows.map(r => [String(r.dia).substring(0, 10), r.total]));
    const serieFinal = serie.rows.map(r => ({
      dia: String(r.dia).substring(0, 10),
      conversas_in: r.conversas_in,
      contatos: r.contatos,
      transferidas: transfMap.get(String(r.dia).substring(0, 10)) || 0,
    }));

    return { ok: true, totais, serie: serieFinal, periodo: { de, ate } };
  }

  // ===== TEMPOS =====
  async function tempos(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const { de, ate } = resolverPeriodo(req.query || {});
    const params = [de, ate];
    const whereConta = filtroConta(req.query, 3, params);

    // Pra cada conversa (conta_id+telefone+dia), calcula:
    // - primeira_in: MIN(ts) FILTER (in)
    // - primeira_out: MIN(ts) FILTER (out)
    // - primeira_out_vendedor: MIN(ts) FILTER (out E atendente NOT IN sistema/IA)
    const base = await query(`
      WITH conversas AS (
        SELECT
          conta_id, telefone,
          DATE(timestamp AT TIME ZONE 'America/Sao_Paulo') AS dia,
          MIN(timestamp) FILTER (WHERE direcao='in') AS primeira_in,
          MIN(timestamp) FILTER (WHERE direcao='out') AS primeira_out,
          MIN(timestamp) FILTER (
            WHERE direcao='out' AND LOWER(COALESCE(atendente,'')) NOT IN ('sistema','ia_blackfriday','triagem_ia','ia_followup','disparo','disparos')
              AND LOWER(COALESCE(atendente,'')) NOT LIKE 'disparo%'
          ) AS primeira_out_vendedor
        FROM chat_mensagens
        WHERE timestamp >= $1 AND timestamp <= $2 ${whereConta}
        GROUP BY conta_id, telefone, dia
      )
      SELECT * FROM conversas WHERE primeira_in IS NOT NULL
    `, params);

    // Pra atribuicao/finalizacao, cruza com chat_conversa_dono
    const atribParams = [de, ate];
    const whereCd = filtroConta(req.query, 3, atribParams);
    const dono = await query(`
      SELECT conta_id, telefone, atribuido_em, finalizada_em
      FROM chat_conversa_dono
      WHERE (atribuido_em >= $1 OR finalizada_em >= $1)
        AND (atribuido_em <= $2 OR finalizada_em <= $2) ${whereCd}
    `, atribParams).catch(() => ({ rows: [] }));
    const donoMap = new Map();
    for (const d of dono.rows) {
      donoMap.set(`${d.conta_id}|${d.telefone}`, d);
    }

    const buckets = {
      pendente_atribuir: { total: 0, soma_s: 0, _15:0, _30:0, _60:0, _120:0, _180:0, mais:0 },
      primeira_interacao: { total: 0, soma_s: 0, _15:0, _30:0, _60:0, _120:0, _180:0, mais:0 },
      primeira_resposta_vendedor: { total: 0, soma_s: 0, _15:0, _30:0, _60:0, _120:0, _180:0, mais:0 },
      conclusao_vendedor: { total: 0, soma_s: 0, _15:0, _30:0, _60:0, _120:0, _180:0, mais:0 },
      resolucao_batepapo: { total: 0, soma_s: 0, _15:0, _30:0, _60:0, _120:0, _180:0, mais:0 },
    };
    const classif = (b, s) => {
      b.total++; b.soma_s += s;
      const min = s / 60;
      if (min < 15) b._15++;
      else if (min < 30) b._30++;
      else if (min < 60) b._60++;
      else if (min < 120) b._120++;
      else if (min < 180) b._180++;
      else b.mais++;
    };

    for (const c of base.rows) {
      const key = `${c.conta_id}|${c.telefone}`;
      const d = donoMap.get(key);
      const inMs = new Date(c.primeira_in).getTime();
      if (c.primeira_out) {
        const diff = (new Date(c.primeira_out).getTime() - inMs) / 1000;
        if (diff >= 0 && diff < 86400 * 7) classif(buckets.primeira_interacao, diff);
      }
      if (c.primeira_out_vendedor) {
        const diff = (new Date(c.primeira_out_vendedor).getTime() - inMs) / 1000;
        if (diff >= 0 && diff < 86400 * 7) classif(buckets.primeira_resposta_vendedor, diff);
      }
      if (d && d.atribuido_em) {
        const diff = (new Date(d.atribuido_em).getTime() - inMs) / 1000;
        if (diff >= 0 && diff < 86400 * 7) classif(buckets.pendente_atribuir, diff);
      }
      if (d && d.finalizada_em && c.primeira_out_vendedor) {
        const diff = (new Date(d.finalizada_em).getTime() - new Date(c.primeira_out_vendedor).getTime()) / 1000;
        if (diff >= 0 && diff < 86400 * 7) classif(buckets.conclusao_vendedor, diff);
      }
      if (d && d.finalizada_em) {
        const diff = (new Date(d.finalizada_em).getTime() - inMs) / 1000;
        if (diff >= 0 && diff < 86400 * 7) classif(buckets.resolucao_batepapo, diff);
      }
    }

    const fmt = (b) => ({
      total: b.total,
      media_min: b.total ? Math.round(b.soma_s / b.total / 60) : 0,
      media_hhmm: b.total ? segParaHHMM(b.soma_s / b.total) : '00 hrs 00 min',
      distribuicao: [
        { bucket: '-15 min', count: b._15, pct: b.total ? b._15*100/b.total : 0 },
        { bucket: '15-30 min', count: b._30, pct: b.total ? b._30*100/b.total : 0 },
        { bucket: '30-60 min', count: b._60, pct: b.total ? b._60*100/b.total : 0 },
        { bucket: '1-2 hrs', count: b._120, pct: b.total ? b._120*100/b.total : 0 },
        { bucket: '2-3 hrs', count: b._180, pct: b.total ? b._180*100/b.total : 0 },
        { bucket: '+3 hrs', count: b.mais, pct: b.total ? b.mais*100/b.total : 0 },
      ],
    });

    return {
      ok: true, periodo: { de, ate },
      tempos: {
        pendente_atribuir: fmt(buckets.pendente_atribuir),
        primeira_interacao: fmt(buckets.primeira_interacao),
        primeira_resposta_vendedor: fmt(buckets.primeira_resposta_vendedor),
        conclusao_vendedor: fmt(buckets.conclusao_vendedor),
        resolucao_batepapo: fmt(buckets.resolucao_batepapo),
      }
    };
  }

  // ===== HEATMAP =====
  async function heatmap(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const { de, ate } = resolverPeriodo(req.query || {});
    const params = [de, ate];
    const whereConta = filtroConta(req.query, 3, params);

    // Cada conversa conta UMA vez por dia (dia×hora da primeira msg_in do dia)
    const r = await query(`
      WITH primeiras AS (
        SELECT conta_id, telefone,
               DATE(timestamp AT TIME ZONE 'America/Sao_Paulo') AS dia,
               MIN(timestamp) AS primeiro_ts
        FROM chat_mensagens
        WHERE direcao='in' AND timestamp >= $1 AND timestamp <= $2 ${whereConta}
        GROUP BY conta_id, telefone, dia
      ),
      agg AS (
        SELECT EXTRACT(DOW FROM primeiro_ts AT TIME ZONE 'America/Sao_Paulo')::int AS dia_sem,
               EXTRACT(HOUR FROM primeiro_ts AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
               COUNT(*)::int AS conversas
        FROM primeiras
        GROUP BY dia_sem, hora
      )
      SELECT * FROM agg
    `, params);

    // Monta matriz 7x24
    const matriz = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const row of r.rows) {
      matriz[row.dia_sem][row.hora] = row.conversas;
    }
    // Resumos
    const totalPorDia = matriz.map(h => h.reduce((a, b) => a + b, 0));
    const totalPorHora = Array(24).fill(0);
    for (const h of matriz) for (let i = 0; i < 24; i++) totalPorHora[i] += h[i];

    // Dias em que o totalPorDia é maior/menor (ignora dias sem dados)
    const comDados = totalPorDia.map((v, i) => ({ dia: i, total: v })).filter(x => x.total > 0);
    const maxDia = comDados.length ? Math.max(...comDados.map(x => x.total)) : 0;
    const minDia = comDados.length ? Math.min(...comDados.map(x => x.total)) : 0;
    const diasMais = comDados.filter(x => x.total === maxDia).map(x => x.dia);
    const diasMenos = comDados.filter(x => x.total === minDia).map(x => x.dia);
    const maxHora = Math.max(...totalPorHora);
    const horasMais = totalPorHora.map((v, i) => ({ hora: i, total: v })).filter(x => x.total === maxHora && maxHora > 0).map(x => x.hora);

    // Calcula "media por dia" (dividindo por semanas no range)
    const diasDoRange = Math.max(1, Math.ceil((new Date(ate) - new Date(de)) / 86400000));
    const semanasAprox = Math.max(1, diasDoRange / 7);
    const mediaPorDia = totalPorDia.map(v => (v / semanasAprox).toFixed(2));
    const mediaPorHora = totalPorHora.map(v => (v / diasDoRange).toFixed(2));

    return {
      ok: true, periodo: { de, ate }, diasDoRange,
      matriz, totalPorDia, totalPorHora,
      mediaPorDia, mediaPorHora,
      diasMais, diasMenos, horasMais,
      maxValor: Math.max(...matriz.flat()),
    };
  }

  // Contas pro dropdown de filtro
  async function contas(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const r = await query(`SELECT codigo, nome, tipo FROM chat_contas ORDER BY nome`);
    return { ok: true, contas: r.rows };
  }

  fastify.get('/webhook/chat-analises-volume', volume);
  fastify.get('/webhook/chat-analises-tempos', tempos);
  fastify.get('/webhook/chat-analises-heatmap', heatmap);
  fastify.get('/webhook/chat-analises-contas', contas);
}

function segParaHHMM(seg) {
  const totalMin = Math.round(seg / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')} hrs ${String(m).padStart(2, '0')} min`;
}
