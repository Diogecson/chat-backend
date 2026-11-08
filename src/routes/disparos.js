import { query } from '../services/db.js';
import { getBoss, QUEUES } from '../services/queue.js';
import { hasDb } from '../config.js';

export default async function disparosRoutes(fastify) {
  // Criar campanha de disparo (equivalente ao chat-disparos-criar do n8n)
  fastify.post('/disparos/criar', async (req, reply) => {
    if (!hasDb()) {
      reply.code(503);
      return { ok: false, erro: 'DATABASE_URL não configurado' };
    }

    const b = req.body || {};
    const conta_id = (b.conta_id || '').toString();
    const template_name = (b.template_name || '').toString();
    const destinatarios = Array.isArray(b.destinatarios) ? b.destinatarios : [];

    if (!conta_id) return reply.code(400).send({ ok: false, erro: 'conta_id obrigatório' });
    if (!template_name) return reply.code(400).send({ ok: false, erro: 'template_name obrigatório' });
    if (!destinatarios.length) return reply.code(400).send({ ok: false, erro: 'destinatarios vazio' });

    // Dedup telefones (normaliza só dígitos, mantém 1ª ocorrência)
    const seen = new Set();
    const dest = [];
    for (const d of destinatarios) {
      const tel = String(d?.telefone || '').replace(/\D/g, '');
      if (!tel || tel.length < 10) continue;
      if (seen.has(tel)) continue;
      seen.add(tel);
      dest.push({
        telefone: tel,
        nome: String(d?.nome || '').substring(0, 120),
        extra_vars: Array.isArray(d?.extra_vars) ? d.extra_vars : [],
      });
    }

    if (!dest.length) return reply.code(400).send({ ok: false, erro: 'nenhum telefone válido' });

    // TODO: inserir chat_disparos + chat_disparos_msgs + enfileirar no pg-boss
    // Esqueleto por enquanto só valida e retorna
    return {
      ok: true,
      campanha_codigo: `disp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      total_msgs: dest.length,
      dedup_removidos: destinatarios.length - dest.length,
      skeleton: true,
      next_step: 'implementar insert + enqueue',
    };
  });

  // Listar campanhas (simples por ora)
  fastify.get('/disparos/list', async (req, reply) => {
    if (!hasDb()) {
      reply.code(503);
      return { ok: false, erro: 'DATABASE_URL não configurado' };
    }
    const conta_id = req.query?.conta_id;
    const sql = conta_id
      ? `SELECT codigo, nome, conta_id, total_msgs, enviadas, falharam, status, criado_em
         FROM chat_disparos WHERE conta_id = $1 ORDER BY criado_em DESC LIMIT 50`
      : `SELECT codigo, nome, conta_id, total_msgs, enviadas, falharam, status, criado_em
         FROM chat_disparos ORDER BY criado_em DESC LIMIT 50`;
    try {
      const res = await query(sql, conta_id ? [conta_id] : []);
      return { ok: true, campanhas: res.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });
}
