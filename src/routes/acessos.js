// Rotas do painel de acessos (seguranca MVP)
import { query } from '../services/db.js';
import { hasDb } from '../config.js';
import { ensureAcessoSchema } from '../services/acesso-log.js';

async function lookupIpInfo(ip) {
  // Cache no banco por 30 dias
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return { ip, hostname: 'local', pais: 'LOCAL', cidade: '', org: 'rede interna' };
  }
  const cached = await query(`SELECT * FROM chat_acesso_ip_info WHERE ip=$1 LIMIT 1`, [ip]).catch(() => ({ rows: [] }));
  if (cached.rows.length) return cached.rows[0];
  // Consulta ipapi.co (free, sem key, limite 1k/dia)
  try {
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { 'User-Agent': 'chat-backend/1.0' },
    });
    const d = await r.json().catch(() => ({}));
    const info = {
      ip,
      hostname: d.hostname || '',
      pais: d.country_name ? String(d.country_name).substring(0, 80) : (d.country || ''),
      cidade: d.city ? String(d.city).substring(0, 120) : '',
      org: d.org ? String(d.org).substring(0, 300) : '',
    };
    await query(
      `INSERT INTO chat_acesso_ip_info (ip, hostname, pais, cidade, org, consultado_em)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (ip) DO UPDATE SET hostname=EXCLUDED.hostname, pais=EXCLUDED.pais, cidade=EXCLUDED.cidade, org=EXCLUDED.org, consultado_em=NOW()`,
      [info.ip, info.hostname, info.pais, info.cidade, info.org]
    ).catch(() => {});
    return info;
  } catch (_) {
    return { ip, hostname: '', pais: '', cidade: '', org: '' };
  }
}

export default async function acessosRoutes(fastify) {
  async function kpis(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureAcessoSchema();
    const janela = parseInt(req.query?.horas || '24') || 24;
    const r = await query(`
      WITH j AS (
        SELECT * FROM chat_acesso_log WHERE minuto >= NOW() - ($1 || ' hours')::INTERVAL
      )
      SELECT
        COALESCE(SUM(count),0)::int AS total_req,
        COUNT(DISTINCT ip)::int AS ips_unicos,
        COUNT(DISTINCT rota)::int AS rotas_unicas,
        COALESCE(SUM(status_401 + status_403),0)::int AS bloqueios,
        COALESCE(SUM(status_404),0)::int AS nao_encontrado,
        COALESCE(SUM(status_5xx),0)::int AS erros_5xx
      FROM j
    `, [String(janela)]);
    const topRotas = await query(`
      SELECT rota, metodo, SUM(count)::int AS total, COUNT(DISTINCT ip)::int AS ips
      FROM chat_acesso_log
      WHERE minuto >= NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY rota, metodo ORDER BY total DESC LIMIT 10
    `, [String(janela)]);
    const topIps = await query(`
      SELECT ip, SUM(count)::int AS total, COUNT(DISTINCT rota)::int AS rotas,
             MAX(minuto) AS ultima
      FROM chat_acesso_log
      WHERE minuto >= NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY ip ORDER BY total DESC LIMIT 15
    `, [String(janela)]);
    return { ok: true, janela_horas: janela, kpis: r.rows[0] || {}, top_rotas: topRotas.rows, top_ips: topIps.rows };
  }

  async function listar(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureAcessoSchema();
    const q = req.query || {};
    const minutos = parseInt(q.minutos || '60') || 60;
    const ip = q.ip ? String(q.ip).trim() : '';
    const rota = q.rota ? String(q.rota).trim() : '';
    const soErros = q.so_erros === 'true' || q.so_erros === '1';
    const limit = Math.min(parseInt(q.limit || '200') || 200, 1000);
    const where = [`minuto >= NOW() - ($1 || ' minutes')::INTERVAL`];
    const params = [String(minutos)];
    if (ip) { params.push(ip); where.push(`ip = $${params.length}`); }
    if (rota) { params.push('%' + rota + '%'); where.push(`rota ILIKE $${params.length}`); }
    if (soErros) where.push('(status_401 + status_403 + status_404 + status_5xx) > 0');
    const sql = `
      SELECT minuto, ip, rota, metodo, count, status_ok, status_401, status_403, status_404, status_5xx,
             ultimo_user_agent, ultimo_usuario
      FROM chat_acesso_log
      WHERE ${where.join(' AND ')}
      ORDER BY minuto DESC, count DESC
      LIMIT ${limit}
    `;
    const r = await query(sql, params);
    return { ok: true, linhas: r.rows };
  }

  async function detalheIp(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureAcessoSchema();
    const ip = String(req.params?.ip || '').trim();
    if (!ip) return reply.code(400).send({ ok: false, erro: 'ip obrigatorio' });
    const info = await lookupIpInfo(ip);
    const janela = parseInt(req.query?.horas || '24') || 24;
    const rotas = await query(`
      SELECT rota, metodo, SUM(count)::int AS total,
             SUM(status_ok)::int AS ok, SUM(status_401 + status_403 + status_404 + status_5xx)::int AS err,
             MAX(minuto) AS ultima
      FROM chat_acesso_log
      WHERE ip=$1 AND minuto >= NOW() - ($2 || ' hours')::INTERVAL
      GROUP BY rota, metodo ORDER BY total DESC LIMIT 100
    `, [ip, String(janela)]);
    const uas = await query(`
      SELECT DISTINCT ultimo_user_agent FROM chat_acesso_log
      WHERE ip=$1 AND ultimo_user_agent IS NOT NULL AND ultimo_user_agent <> ''
        AND minuto >= NOW() - ($2 || ' hours')::INTERVAL
      LIMIT 10
    `, [ip, String(janela)]);
    const usuarios = await query(`
      SELECT DISTINCT ultimo_usuario FROM chat_acesso_log
      WHERE ip=$1 AND ultimo_usuario IS NOT NULL AND ultimo_usuario <> ''
        AND minuto >= NOW() - ($2 || ' hours')::INTERVAL
      LIMIT 10
    `, [ip, String(janela)]);
    return { ok: true, info, rotas: rotas.rows, user_agents: uas.rows.map(x => x.ultimo_user_agent), usuarios: usuarios.rows.map(x => x.ultimo_usuario) };
  }

  async function serieTempo(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureAcessoSchema();
    const horas = parseInt(req.query?.horas || '24') || 24;
    // Agrega por 5 minutos
    const r = await query(`
      SELECT date_trunc('hour', minuto) + (floor(extract(minute from minuto)/5)*5 || ' minutes')::INTERVAL AS bucket,
             SUM(count)::int AS total,
             SUM(status_401 + status_403)::int AS bloqueios,
             SUM(status_5xx)::int AS erros
      FROM chat_acesso_log
      WHERE minuto >= NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY bucket ORDER BY bucket ASC
    `, [String(horas)]);
    return { ok: true, serie: r.rows };
  }

  fastify.get('/webhook/chat-acessos-kpis', kpis);
  fastify.get('/webhook/chat-acessos-list', listar);
  fastify.get('/webhook/chat-acessos-ip/:ip', detalheIp);
  fastify.get('/webhook/chat-acessos-serie', serieTempo);
}
