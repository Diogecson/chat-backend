// /webhook/chat-matriculas-* — gestao da base de alunos matriculados
// Ideia: usuario sobe CSV/xlsx com telefone+nome+curso+polo todo dia;
// o sistema cruza por telefone com as conversas pra contar quem ja virou aluno.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

let tabelaGarantida = false;
async function garantirTabela() {
  if (tabelaGarantida) return;
  await query(`
    CREATE TABLE IF NOT EXISTS chat_alunos_matriculados (
      telefone   TEXT PRIMARY KEY,
      nome       TEXT DEFAULT '',
      curso      TEXT DEFAULT '',
      polo       TEXT DEFAULT '',
      criado_em      TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Garante o motivo 'matricula_base' pra marcar as conversas como ganho
  await query(`
    INSERT INTO chat_motivos_fechamento (codigo, nome, tipo, cor, ordem)
    VALUES ('matricula_base', 'Matrícula (base de alunos)', 'ganho', '#16a34a', 1)
    ON CONFLICT (codigo) DO NOTHING
  `).catch(() => {});
  tabelaGarantida = true;
}

// Finaliza automaticamente as conversas cujos telefones estao na base de alunos,
// marcando com motivo tipo 'ganho' pra elas cairem no card "Matrículas" e sumirem
// do card "Finalizadas" e dos atendimentos ativos.
async function marcarConversasComoMatricula() {
  try {
    const r = await query(`
      WITH tels AS (
        SELECT DISTINCT cm.conta_id, cm.telefone
        FROM chat_mensagens cm
        INNER JOIN chat_alunos_matriculados am ON am.telefone = cm.telefone
      )
      INSERT INTO chat_conversa_dono
        (conta_id, telefone, atendente, finalizada, finalizada_em, finalizada_por, motivo_fechamento, atribuido_em, atribuido_por)
      SELECT t.conta_id, t.telefone, '', true, NOW(), 'base_alunos', 'matricula_base', NOW(), 'base_alunos'
      FROM tels t
      ON CONFLICT (conta_id, telefone) DO UPDATE
        SET finalizada = true,
            finalizada_em = COALESCE(chat_conversa_dono.finalizada_em, NOW()),
            finalizada_por = COALESCE(NULLIF(chat_conversa_dono.finalizada_por,''), 'base_alunos'),
            motivo_fechamento = 'matricula_base'
      RETURNING conta_id
    `);
    return r.rowCount || 0;
  } catch (err) {
    console.error('[matriculas] marcarConversasComoMatricula falhou', err.message);
    return -1;
  }
}

function normTel(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return '';
  // Se vier com 10-11 digitos (só DDD+numero), prefixa 55
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

export default async function matriculasRoutes(fastify) {
  // POST /webhook/chat-matriculas-upload
  // body: { modo: 'merge'|'substituir', alunos: [{telefone, nome, curso, polo}, ...] }
  const upload = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await garantirTabela();
    const b = req.body || {};
    const alunos = Array.isArray(b.alunos) ? b.alunos : [];
    const modo = String(b.modo || 'merge').toLowerCase();
    if (!alunos.length) return reply.code(400).send({ ok: false, erro: 'nenhum aluno enviado' });

    // Dedup por telefone normalizado
    const map = new Map();
    for (const a of alunos) {
      const tel = normTel(a.telefone);
      if (!tel) continue;
      map.set(tel, {
        telefone: tel,
        nome: String(a.nome || '').substring(0, 300),
        curso: String(a.curso || '').substring(0, 200),
        polo: String(a.polo || '').substring(0, 200),
      });
    }
    const rows = Array.from(map.values());
    if (!rows.length) return reply.code(400).send({ ok: false, erro: 'nenhum telefone valido' });

    if (modo === 'substituir') {
      await query(`DELETE FROM chat_alunos_matriculados`);
    }

    // Insert em batches de 500 pra nao estourar query size
    const BATCH = 500;
    let inseridos = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const vals = [];
      const params = [];
      slice.forEach((r, idx) => {
        const base = idx * 4;
        vals.push(`($${base+1},$${base+2},$${base+3},$${base+4},NOW())`);
        params.push(r.telefone, r.nome, r.curso, r.polo);
      });
      const sql = `
        INSERT INTO chat_alunos_matriculados (telefone, nome, curso, polo, atualizado_em)
        VALUES ${vals.join(',')}
        ON CONFLICT (telefone) DO UPDATE SET
          nome = COALESCE(NULLIF(EXCLUDED.nome,''), chat_alunos_matriculados.nome),
          curso = COALESCE(NULLIF(EXCLUDED.curso,''), chat_alunos_matriculados.curso),
          polo = COALESCE(NULLIF(EXCLUDED.polo,''), chat_alunos_matriculados.polo),
          atualizado_em = NOW()
      `;
      const r = await query(sql, params);
      inseridos += slice.length;
    }

    const totalRes = await query(`SELECT COUNT(*)::int AS t FROM chat_alunos_matriculados`);

    // Marca as conversas desses telefones como "matrícula" (ganho) pra cair
    // no funil de matrículas e sair das visões normais. Default: true.
    const marcar = b.marcar_como_matricula !== false;
    const conversasMarcadas = marcar ? await marcarConversasComoMatricula() : 0;

    return {
      ok: true,
      enviados: alunos.length,
      validos: rows.length,
      processados: inseridos,
      total_na_base: totalRes.rows[0].t,
      conversas_marcadas_matricula: conversasMarcadas,
      modo,
    };
  };
  fastify.post('/webhook/chat-matriculas-upload', upload);
  fastify.post('/api/chat/matriculas-upload', upload);

  // POST /webhook/chat-matriculas-reprocessar — roda só o marcar sem subir base nova
  // Útil se o usuário já subiu a base antes do deploy dessa feature.
  const reprocessar = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await garantirTabela();
    const marcadas = await marcarConversasComoMatricula();
    return { ok: true, conversas_marcadas_matricula: marcadas };
  };
  fastify.post('/webhook/chat-matriculas-reprocessar', reprocessar);
  fastify.get('/webhook/chat-matriculas-reprocessar', reprocessar);

  // GET /webhook/chat-matriculas-stats — numero de matriculas por consultor
  // Match: telefone em chat_alunos_matriculados + dono em chat_conversa_dono
  // Aceita ?contas_permitidas=csv ou __all__ pra isolar por conta
  const stats = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await garantirTabela();
    const perm = String(req.query?.contas_permitidas || req.body?.contas_permitidas || '__all__').trim();
    const filtroConta = (perm && perm !== '__all__' && perm !== '*' && perm !== '__none__');
    try {
      const totalRes = await query(`SELECT COUNT(*)::int AS t FROM chat_alunos_matriculados`);
      const atualRes = await query(`SELECT MAX(atualizado_em) AS ultimo FROM chat_alunos_matriculados`);
      const consultorRes = await query(
        filtroConta
          ? `SELECT LOWER(cd.atendente) AS atendente,
                    COUNT(DISTINCT am.telefone)::int AS matriculas
             FROM chat_alunos_matriculados am
             INNER JOIN chat_conversa_dono cd ON cd.telefone = am.telefone
             WHERE cd.atendente <> ''
               AND cd.atendente NOT IN ('triagem_ia','ia_followup','sistema','')
               AND cd.conta_id = ANY(string_to_array($1, ','))
             GROUP BY LOWER(cd.atendente)
             ORDER BY matriculas DESC`
          : `SELECT LOWER(cd.atendente) AS atendente,
                    COUNT(DISTINCT am.telefone)::int AS matriculas
             FROM chat_alunos_matriculados am
             INNER JOIN chat_conversa_dono cd ON cd.telefone = am.telefone
             WHERE cd.atendente <> ''
               AND cd.atendente NOT IN ('triagem_ia','ia_followup','sistema','')
             GROUP BY LOWER(cd.atendente)
             ORDER BY matriculas DESC`,
        filtroConta ? [perm] : []
      );
      return {
        ok: true,
        total_na_base: totalRes.rows[0].t,
        ultima_atualizacao: atualRes.rows[0].ultimo,
        por_consultor: consultorRes.rows,
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  };
  fastify.get('/webhook/chat-matriculas-stats', stats);
  fastify.post('/webhook/chat-matriculas-stats', stats);

  // GET /webhook/chat-matriculas-check?telefone=... — verifica se é aluno
  const check = async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await garantirTabela();
    const tel = normTel(req.query?.telefone || req.body?.telefone);
    if (!tel) return { ok: true, aluno: false };
    const r = await query(`SELECT nome, curso, polo, atualizado_em FROM chat_alunos_matriculados WHERE telefone=$1 LIMIT 1`, [tel]);
    if (!r.rows.length) return { ok: true, aluno: false };
    return { ok: true, aluno: true, ...r.rows[0] };
  };
  fastify.get('/webhook/chat-matriculas-check', check);
  fastify.post('/webhook/chat-matriculas-check', check);
}
