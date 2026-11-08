import { query } from '../services/db.js';
import { hasDb } from '../config.js';

export default async function authRoutes(fastify) {
  // Login — por enquanto consulta chat_atendentes (mesma tabela que o n8n usa)
  // Autenticação simplificada: senha em texto plano (igual ao que o sistema atual faz)
  fastify.post('/auth/login', async (req, reply) => {
    const { usuario, senha } = req.body || {};
    if (!usuario || !senha) {
      return reply.code(400).send({ ok: false, erro: 'usuario e senha obrigatórios' });
    }

    if (!hasDb()) {
      // Modo dev/fallback: aceita admin/admin
      if (usuario === 'admin' && senha === 'admin') {
        return { ok: true, token: 'dev-mode-token', user: { usuario: 'admin', papel: 'SUPER', fonte: 'fallback' } };
      }
      return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
    }

    try {
      const res = await query(
        `SELECT usuario, nome, papel, ativo, contas_permitidas, foto_url
         FROM chat_atendentes
         WHERE LOWER(usuario) = LOWER($1) AND senha = $2
         LIMIT 1`,
        [usuario.trim(), senha]
      );
      if (!res.rows.length) {
        return reply.code(401).send({ ok: false, erro: 'Usuário ou senha incorretos' });
      }
      const u = res.rows[0];
      if (u.ativo === false) {
        return reply.code(403).send({ ok: false, erro: 'Usuário desativado' });
      }
      return {
        ok: true,
        token: `session-${u.usuario}-${Date.now()}`, // placeholder; depois a gente troca por JWT
        user: {
          usuario: u.usuario,
          nome: u.nome,
          papel: u.papel,
          contas_permitidas: u.contas_permitidas,
          foto_url: u.foto_url,
        },
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, erro: err.message };
    }
  });
}
