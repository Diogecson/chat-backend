import { getPool } from '../services/db.js';
import { config, hasDb } from '../config.js';

export default async function healthRoutes(fastify) {
  // Health básico — sem dependência externa
  fastify.get('/health', async () => ({
    ok: true,
    service: 'chat-backend',
    uptime_s: Math.round(process.uptime()),
    dry_run: config.dryRun,
    has_db: hasDb(),
    timestamp: new Date().toISOString(),
  }));

  // Health com check no banco
  fastify.get('/health/db', async (req, reply) => {
    if (!hasDb()) {
      return { ok: false, reason: 'DATABASE_URL não configurado' };
    }
    try {
      const pool = getPool();
      const res = await pool.query('SELECT NOW() AS now');
      return { ok: true, now: res.rows[0].now };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });
}
