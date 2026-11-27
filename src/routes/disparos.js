import { query, getPool } from '../services/db.js';
import { getBoss, QUEUES } from '../services/queue.js';
import { hasDb } from '../config.js';
import { processarJobDisparos } from '../workers/disparos.worker.js';

function generateCodigo() {
  return 'disp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function parseArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return []; }
  }
  return [];
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function dedupDest(destinatarios) {
  const seen = new Set();
  const dest = [];
  for (const d of destinatarios) {
    const tel = normalizePhone(d?.telefone);
    if (!tel || tel.length < 10) continue;
    if (seen.has(tel)) continue;
    seen.add(tel);
    dest.push({
      telefone: tel,
      nome: String(d?.nome || '').substring(0, 120),
      extra_vars: parseArray(d?.extra_vars),
    });
  }
  return dest;
}

// Handler exportado pra poder ser chamado por outras rotas (ex: /webhook/chat-disparos-criar)
export async function handleDisparoCriar(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });

    const b = req.body || {};
    const conta_id = String(b.conta_id || '').trim();
    const nome = (b.nome || 'Campanha ' + new Date().toLocaleDateString('pt-BR')).toString().substring(0, 120);
    const template_name = String(b.template_name || '').trim();
    const template_language = String(b.template_language || 'pt_BR').trim();
    const template_body_vars = parseArray(b.template_body_vars);
    const template_body_text = String(b.template_body_text || '').substring(0, 4000);
    const quando_agendar = b.quando_agendar || null;
    const atendente = String(b.usuario || b.atendente || 'sistema').trim();
    const dono = String(b.dono || '').trim().toLowerCase();
    const pular_existentes = !!b.pular_existentes;

    if (!conta_id) return reply.code(400).send({ ok: false, erro: 'conta_id obrigatório' });
    if (!template_name) return reply.code(400).send({ ok: false, erro: 'template_name obrigatório' });

    const dest = dedupDest(Array.isArray(b.destinatarios) ? b.destinatarios : []);
    if (!dest.length) return reply.code(400).send({ ok: false, erro: 'nenhum telefone válido' });

    // Checa qualidade do template na Meta ANTES de criar o disparo.
    // Bloqueia se PAUSED/DISABLED/REJECTED ou qualidade=RED.
    // Pode ser desligado com BLOQUEAR_DISPAROS_QUALIDADE_RUIM=false.
    if (process.env.BLOQUEAR_DISPAROS_QUALIDADE_RUIM !== 'false' && !b.forcar_qualidade_ruim) {
      try {
        const { getTemplateQualidade } = await import('./templates.js');
        const q = await getTemplateQualidade(conta_id, template_name);
        if (q.ok && !q.pode_disparar) {
          return reply.code(400).send({
            ok: false,
            erro: `Disparo bloqueado: ${q.motivo}. Status=${q.status}, qualidade=${q.qualidade}. Use outro template ou passe forcar_qualidade_ruim=true pra ignorar.`,
            qualidade: q,
          });
        }
        if (q.ok && q.qualidade === 'YELLOW') {
          // Aviso mas nao bloqueia
          console.log(`[disparos] atencao: template "${template_name}" qualidade YELLOW — disparo pode piorar quality score`);
        }
      } catch (err) {
        console.warn('[disparos] nao foi possivel checar qualidade do template:', err.message);
        // Em caso de falha da API, nao bloqueia — permite disparar
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // (opcional) filtra existentes — telefones que já têm msg na conta
      let destFinal = dest;
      let pulados = [];
      if (pular_existentes) {
        const telsCsv = dest.map(d => d.telefone).join(',');
        const existRes = await client.query(
          `SELECT DISTINCT telefone FROM chat_mensagens WHERE conta_id = $1 AND telefone = ANY(string_to_array($2, ','))`,
          [conta_id, telsCsv]
        );
        const existentes = new Set(existRes.rows.map(r => r.telefone));
        destFinal = dest.filter(d => !existentes.has(d.telefone));
        pulados = dest.filter(d => existentes.has(d.telefone));
      }

      const codigo = generateCodigo();
      const totalMsgs = destFinal.length;
      // Só considera agendamento se a data for FUTURA (ignora quando_agendar passado/vazio)
      let quando = null;
      if (quando_agendar) {
        const d = new Date(quando_agendar);
        if (!isNaN(d.getTime()) && d.getTime() > Date.now()) quando = d.toISOString();
      }
      const status = totalMsgs === 0 ? 'concluido' : (quando ? 'agendado' : 'em_andamento');

      // Insere campanha
      await client.query(
        `INSERT INTO chat_disparos (codigo, nome, conta_id, template_name, template_language, template_body_vars,
                                    quando_agendar, status, total_msgs, atendente, dono, pulados_json, template_body_text)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8,$9,$10,$11,$12::jsonb,$13)`,
        [codigo, nome, conta_id, template_name, template_language, JSON.stringify(template_body_vars),
         quando, status, totalMsgs, atendente, dono, JSON.stringify(pulados), template_body_text]
      );

      // Insere msgs (bulk) e pega os ids retornados
      const msgIds = [];
      if (destFinal.length) {
        // insert em bulk via unnest
        const tels = destFinal.map(d => d.telefone);
        const nomes = destFinal.map(d => d.nome);
        const extras = destFinal.map(d => JSON.stringify(d.extra_vars));
        const insRes = await client.query(
          `INSERT INTO chat_disparos_msgs (campanha_id, telefone, nome, extra_vars, status)
           SELECT $1, t, n, e::jsonb, 'pendente'
           FROM unnest($2::text[], $3::text[], $4::text[]) AS u(t, n, e)
           RETURNING id`,
          [codigo, tels, nomes, extras]
        );
        for (const r of insRes.rows) msgIds.push(r.id);
      }

      await client.query('COMMIT');

      // Enfileira (só se for pra começar imediato, não agendado)
      let enqueued = 0;
      if (!quando && msgIds.length) {
        const boss = await getBoss();
        if (boss) {
          for (const msgId of msgIds) {
            await boss.send(QUEUES.DISPAROS, { msg_id: msgId, campanha_id: codigo });
            enqueued++;
          }
        }
      }

      return {
        ok: true,
        campanha_codigo: codigo,
        total_msgs: totalMsgs,
        dedup_removidos: (Array.isArray(b.destinatarios) ? b.destinatarios.length : 0) - dest.length,
        pulados_existentes: pulados.length,
        enqueued,
        agendado: !!quando,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      reply.code(500);
      return { ok: false, erro: err.message };
    } finally {
      client.release();
    }
}

// Cancela uma campanha e todas as msgs pendentes/em_envio dela
export async function handleDisparoCancelar(req, reply) {
  if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
  const codigo = req.body?.campanha || req.body?.campanha_codigo || req.params?.codigo;
  if (!codigo) return reply.code(400).send({ ok: false, erro: 'campanha obrigatorio' });
  try {
    await query(`UPDATE chat_disparos SET status='cancelado', atualizado_em=NOW() WHERE codigo=$1`, [codigo]);
    const r = await query(
      `UPDATE chat_disparos_msgs SET status='cancelado', erro_msg='Cancelado manualmente'
       WHERE campanha_id=$1 AND status IN ('pendente','em_envio')`,
      [codigo]
    );
    return { ok: true, msgs_canceladas: r.rowCount };
  } catch (err) {
    console.error('[cancelar]', err.message);
    reply.code(500);
    return { ok: false, erro: err.message };
  }
}

// Pausa/retoma: muda status entre 'em_andamento' <-> 'pausado'.
// Worker e cron agendados-disparar NAO processam 'pausado'.
export async function handleDisparoPausar(req, reply) {
  if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
  const codigo = req.body?.campanha || req.body?.campanha_codigo;
  const acao = String(req.body?.acao || 'pausar').toLowerCase();
  if (!codigo) return reply.code(400).send({ ok: false, erro: 'campanha obrigatorio' });
  try {
    if (acao === 'retomar') {
      await query(
        `UPDATE chat_disparos SET status='em_andamento', atualizado_em=NOW() WHERE codigo=$1 AND status='pausado'`,
        [codigo]
      );
    } else {
      await query(
        `UPDATE chat_disparos SET status='pausado', atualizado_em=NOW() WHERE codigo=$1 AND status IN ('em_andamento','agendado')`,
        [codigo]
      );
    }
    return { ok: true, acao };
  } catch (err) {
    console.error('[pausar]', err.message);
    reply.code(500);
    return { ok: false, erro: err.message };
  }
}

// Exportado standalone pra ser usado por aliases.js (rota /webhook/...).
// Resetta msgs em_envio -> pendente e processa ate 20 msgs em-processo
// chamando o worker direto, sem passar pelo pg-boss.
export async function handleDisparoReenfileirar(req, reply) {
  const trace = [];
  try {
    trace.push('start');
    if (!hasDb()) {
      reply.code(503);
      return { ok: false, erro: 'DATABASE_URL não configurado', trace };
    }
    const codigo = req.body?.campanha_codigo || null;
    trace.push('codigo=' + codigo);

    // 1) Destrava em_envio antigo -> pendente
    try {
      if (codigo) {
        await query(
          `UPDATE chat_disparos_msgs SET status='pendente' WHERE status='em_envio' AND campanha_id=$1`,
          [codigo]
        );
      } else {
        await query(
          `UPDATE chat_disparos_msgs SET status='pendente' WHERE status='em_envio' AND enviado_em < NOW() - INTERVAL '2 minutes'`
        );
      }
      trace.push('destravou');
    } catch (e) {
      trace.push('destravar-falhou: ' + e.message);
    }

    // 2) Pega TODAS as pendentes (ate 5000 pra proteger memoria)
    let rows = [];
    try {
      const sql = codigo
        ? `SELECT m.id, m.campanha_id FROM chat_disparos_msgs m
           JOIN chat_disparos c ON c.codigo = m.campanha_id
           WHERE m.status='pendente' AND c.status IN ('agendado','em_andamento')
             AND m.campanha_id=$1
           LIMIT 5000`
        : `SELECT m.id, m.campanha_id FROM chat_disparos_msgs m
           JOIN chat_disparos c ON c.codigo = m.campanha_id
           WHERE m.status='pendente' AND c.status IN ('agendado','em_andamento')
           LIMIT 5000`;
      const res = await query(sql, codigo ? [codigo] : []);
      rows = res.rows || [];
      trace.push('pendentes=' + rows.length);
    } catch (e) {
      trace.push('select-falhou: ' + e.message);
      reply.code(500);
      return { ok: false, erro: 'select: ' + e.message, trace };
    }

    // 3) Processa SINCRONO ate 20 (resposta rapida com feedback)
    //    e DISPARA o resto EM BACKGROUND (fire-and-forget).
    const SINCRONO = Math.min(20, rows.length);
    let enq = 0, err_count = 0;
    let last_err = '';
    for (let i = 0; i < SINCRONO; i++) {
      const r = rows[i];
      try {
        const result = await processarJobDisparos({ data: { msg_id: r.id, campanha_id: r.campanha_id } });
        if (result && result.ok) enq++;
        else { err_count++; last_err = (result && result.error) || 'nao_pendente'; }
      } catch (e) {
        err_count++;
        last_err = e.message;
        console.error(`[reenfileirar] erro processar msg ${r.id}:`, e.message);
      }
    }
    trace.push('sincrono=' + SINCRONO + ' ok=' + enq + ' erros=' + err_count);

    // Restante em background — nao bloqueia a resposta HTTP
    const restante = rows.slice(SINCRONO);
    if (restante.length) {
      setImmediate(async () => {
        console.log(`[reenfileirar-bg] iniciando ${restante.length} msgs em background`);
        let bg_ok = 0, bg_err = 0;
        for (const r of restante) {
          try {
            const result = await processarJobDisparos({ data: { msg_id: r.id, campanha_id: r.campanha_id } });
            if (result && result.ok) bg_ok++; else bg_err++;
          } catch (e) {
            bg_err++;
            console.error(`[reenfileirar-bg] msg ${r.id}: ${e.message}`);
          }
        }
        console.log(`[reenfileirar-bg] done: ${bg_ok} ok / ${bg_err} erro`);
      });
    }

    return {
      ok: true,
      enfileiradas: enq,
      erros: err_count,
      em_background: restante.length,
      ultimo_erro: last_err,
      trace,
    };
  } catch (err) {
    console.error('[reenfileirar] exception externa:', err.message, err.stack);
    reply.code(500);
    return { ok: false, erro: err.message, trace };
  }
}

export default async function disparosRoutes(fastify) {
  // POST /api/disparos/criar
  fastify.post('/disparos/criar', handleDisparoCriar);

  // Recalcula enviadas/falharam/status das campanhas em andamento.
  // Chamado automaticamente pela UI ao abrir a lista de disparos.
  async function recalcularContadores() {
    try {
      const r = await query(`
        WITH stats AS (
          SELECT campanha_id,
                 COUNT(*) FILTER (WHERE status='enviado') AS e,
                 COUNT(*) FILTER (WHERE status IN ('erro','cancelado')) AS f
          FROM chat_disparos_msgs
          WHERE campanha_id IN (SELECT codigo FROM chat_disparos WHERE status IN ('em_andamento','agendado'))
          GROUP BY campanha_id
        )
        UPDATE chat_disparos c
        SET enviadas = s.e, falharam = s.f, atualizado_em = NOW(),
            status = CASE WHEN s.e + s.f >= c.total_msgs THEN 'concluido' ELSE 'em_andamento' END
        FROM stats s
        WHERE c.codigo = s.campanha_id AND c.status IN ('em_andamento','agendado')
        RETURNING c.codigo, c.status
      `);
      return r.rowCount || 0;
    } catch (err) {
      return -1;
    }
  }

  // POST /api/disparos/recalcular — força recálculo imediato (UI chama ao abrir a tela)
  fastify.post('/disparos/recalcular', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
    const atualizadas = await recalcularContadores();
    return { ok: true, campanhas_atualizadas: atualizadas };
  });
  // Alias webhook pra chat.html que vive em /webhook
  fastify.post('/webhook/chat-disparos-recalcular', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
    const atualizadas = await recalcularContadores();
    return { ok: true, campanhas_atualizadas: atualizadas };
  });

  // GET /api/disparos/list — lista campanhas
  fastify.get('/disparos/list', async (req, reply) => {
    // Recalcula ANTES de listar — garante que a resposta esteja fresca
    await recalcularContadores().catch(() => {});
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
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

  // GET /api/disparos/:codigo — detalhes de uma campanha
  fastify.get('/disparos/:codigo', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'DATABASE_URL não configurado' });
    const { codigo } = req.params;
    try {
      const camp = await query(`SELECT * FROM chat_disparos WHERE codigo=$1`, [codigo]);
      if (!camp.rows.length) return reply.code(404).send({ ok: false, erro: 'não encontrada' });
      const msgs = await query(
        `SELECT id, telefone, nome, status, tentativas, external_id, erro_msg, enviado_em
         FROM chat_disparos_msgs WHERE campanha_id=$1 ORDER BY id LIMIT 500`,
        [codigo]
      );
      return { ok: true, campanha: camp.rows[0], msgs: msgs.rows };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  fastify.post('/disparos/reenfileirar', handleDisparoReenfileirar);
  // NOTA: o alias /webhook/chat-disparos-reenfileirar esta em aliases.js
  // (este arquivo eh registrado com prefix '/api', entao o alias ia virar
  // /api/webhook/... e cair no proxy pro n8n)

  // POST /api/disparos/:codigo/cancelar
  fastify.post('/disparos/:codigo/cancelar', handleDisparoCancelar);
}
