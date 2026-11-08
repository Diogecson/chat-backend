import { query } from '../services/db.js';
import { hasDb } from '../config.js';

export default async function contasRoutes(fastify) {
  fastify.get('/contas', async (req, reply) => {
    if (!hasDb()) {
      reply.code(503);
      return { ok: false, erro: 'DATABASE_URL não configurado' };
    }
    try {
      const res = await query(
        `SELECT codigo, nome, tipo, status
         FROM chat_contas
         ORDER BY nome`
      );
      return { ok: true, contas: res.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });
}
