// Agrega chat_mensagens por telefone pro painel Bases de Leads consumir
// (substitui a extracao manual do Sydle). Retorna no MESMO formato que o
// agregaConversas() do index.html monta a partir do CSV.
//
// GET /webhook/chat-bl-exportar?dias=90&conta_id=X&so_com_cliente=true
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

export default async function blExportarRoutes(fastify) {
  async function handle(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    const q = req.query || {};
    const dias = Math.min(parseInt(q.dias || '90') || 90, 365);
    const conta_id = q.conta_id ? String(q.conta_id) : '';
    const so_com_cliente = q.so_com_cliente !== 'false'; // default true
    const params = [dias];
    const where = [`timestamp >= NOW() - ($1::INT * INTERVAL '1 day')`];
    if (conta_id && conta_id !== '__all__') {
      params.push(conta_id);
      where.push(`conta_id = $${params.length}`);
    }
    const having = so_com_cliente ? `HAVING COUNT(*) FILTER (WHERE direcao='in') > 0` : '';

    let r;
    try {
      r = await query(`
        SELECT
          telefone,
          COUNT(*)::int AS msgs,
          COUNT(*) FILTER (WHERE direcao='in')::int AS msgs_cliente,
          MIN(timestamp) AS primeira,
          MAX(timestamp) AS ultima,
          MAX(timestamp) FILTER (WHERE direcao='in') AS ultima_cliente,
          COUNT(DISTINCT conta_id)::int AS chats
        FROM chat_mensagens
        WHERE ${where.join(' AND ')}
        GROUP BY telefone
        ${having}
        ORDER BY ultima DESC NULLS LAST
      `, params);
    } catch (err) {
      console.error('[bl-exportar] SQL err:', err.message);
      return reply.code(500).send({ ok: false, erro: 'query falhou: ' + err.message });
    }

    // Normaliza datas e telefones
    const toIso = (d) => {
      if (!d) return '';
      if (typeof d === 'string') return d.substring(0, 19);
      try { return new Date(d).toISOString().substring(0, 19); } catch (_) { return ''; }
    };
    const linhas = r.rows.map(x => {
      let tel = String(x.telefone || '').replace(/\D/g, '');
      if ((tel.length === 12 || tel.length === 13) && tel.startsWith('55')) tel = tel.substring(2);
      return {
        telefone: tel,
        msgs: x.msgs,
        msgs_cliente: x.msgs_cliente,
        primeira: toIso(x.primeira),
        ultima: toIso(x.ultima),
        ultima_cliente: toIso(x.ultima_cliente),
        chats: x.chats || 1,
      };
    }).filter(l => l.telefone.length === 10 || l.telefone.length === 11);

    return {
      ok: true,
      linhas,
      meta: {
        total: linhas.length,
        com_cliente: linhas.filter(l => l.msgs_cliente > 0).length,
        periodo_dias: dias,
        conta_id: conta_id || 'todas',
        gerado_em: new Date().toISOString(),
      }
    };
  }

  fastify.get('/webhook/chat-bl-exportar', handle);
  fastify.get('/api/chat/bl-exportar', handle);
}
