// Sincroniza matriculas do Core API (polo x curso x ano) pra agregar
// em chat_polos_turmas. Usado pelo painel Polo mais proximo pra:
// - mostrar total de alunos por polo
// - filtrar polos que tem turma viavel em um curso especifico
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const CORE_API_BASE = process.env.CORE_API_BASE || 'https://core.data.unifecaf.edu.br/api/v1';
const CORE_API_KEY = process.env.CORE_API_KEY || '';
const MIN_ALUNOS_TURMA = parseInt(process.env.MIN_ALUNOS_TURMA || '15', 10);

let schemaEnsured = false;
async function ensureTurmasSchema() {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_polos_turmas (
        polo_chave TEXT NOT NULL,
        curso TEXT NOT NULL,
        ano INT NOT NULL,
        total_alunos INT NOT NULL DEFAULT 0,
        total_ativos INT NOT NULL DEFAULT 0,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (polo_chave, curso, ano)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_polos_turmas_curso ON chat_polos_turmas(curso)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_polos_turmas_polo ON chat_polos_turmas(polo_chave)`);
    schemaEnsured = true;
  } catch (err) {
    console.error('[polos-matriculas-sync] ensureTurmasSchema falhou:', err.message);
  }
}

// Normaliza string pra chave de match (lowercase, sem acentos, sem pontos)
function normalizar(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchPagina({ ano, pagina, limite = 1000 }) {
  const qs = new URLSearchParams();
  qs.set('ano', String(ano));
  qs.set('limite', String(limite));
  qs.set('pagina', String(pagina));
  const url = `${CORE_API_BASE}/dados/matriculas/lista?${qs.toString()}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'X-API-Key': CORE_API_KEY, 'Accept': 'application/json' },
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch (_) { throw new Error('Core nao-JSON: ' + txt.substring(0, 180)); }
  if (!r.ok) throw new Error(data?.detail || data?.erro || `HTTP ${r.status} do core`);
  return {
    linhas: Array.isArray(data?.linhas) ? data.linhas : [],
    total: data?.total || 0,
    tem_mais: data?.tem_mais ?? (data?.linhas?.length === limite),
  };
}

export default async function polosMatriculasSyncRoutes(fastify) {
  async function sync(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    if (!CORE_API_KEY) return reply.code(500).send({ ok: false, erro: 'CORE_API_KEY nao configurado' });
    await ensureTurmasSchema();

    const b = req.body || {};
    const papel = String(b.papel || '').toUpperCase();
    if (papel !== 'SUPER' && papel !== 'ADMIN') {
      return reply.code(403).send({ ok: false, erro: 'so SUPER ou ADMIN pode sincronizar' });
    }
    const ano = parseInt(b.ano || new Date().getFullYear(), 10);
    const maxPaginas = Math.min(parseInt(b.max_paginas || '100') || 100, 500);

    console.log(`[polos-sync] iniciando sync ano=${ano}`);
    // Puxa todas as paginas
    const agregado = new Map(); // chave: `${polo_chave}|${curso}` → {total, ativos}
    let paginaAtual = 1;
    let totalLinhas = 0;
    while (paginaAtual <= maxPaginas) {
      const { linhas, tem_mais } = await fetchPagina({ ano, pagina: paginaAtual });
      if (!linhas.length) break;
      totalLinhas += linhas.length;
      for (const l of linhas) {
        // Tenta varios nomes de campo possiveis
        const polo = l.polo || l.polo_nome || l.nome_polo || l.unidade || '';
        const poloId = l.polo_id || l.polo_codigo || l.polo_cod || '';
        const curso = l.curso || l.curso_nome || l.nome_curso || '';
        const situacao = String(l.situacao || l.situacao_matricula || '').toUpperCase();
        if (!curso || (!polo && !poloId)) continue;
        // Chave do polo: prefere id, senao usa nome normalizado
        const poloChave = String(poloId || polo).trim();
        const cursoNorm = String(curso).trim();
        const key = `${poloChave}|${cursoNorm}`;
        const cur = agregado.get(key) || { total: 0, ativos: 0 };
        cur.total++;
        if (situacao && !['CANCELADA', 'CANCELADO', 'TRANCADA', 'TRANCADO', 'EVADIDA', 'EVADIDO', 'DESISTENTE'].includes(situacao)) {
          cur.ativos++;
        }
        agregado.set(key, cur);
      }
      if (!tem_mais) break;
      paginaAtual++;
    }

    // Grava: TRUNCATE do ano e re-INSERT
    await query(`DELETE FROM chat_polos_turmas WHERE ano=$1`, [ano]);
    let inseridos = 0;
    for (const [key, v] of agregado.entries()) {
      const [polo_chave, curso] = key.split('|');
      await query(
        `INSERT INTO chat_polos_turmas (polo_chave, curso, ano, total_alunos, total_ativos, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [polo_chave, curso, ano, v.total, v.ativos]
      ).catch(err => console.error('[polos-sync] insert err:', err.message));
      inseridos++;
    }
    console.log(`[polos-sync] ano=${ano} paginas=${paginaAtual} linhas=${totalLinhas} grupos=${inseridos}`);
    return {
      ok: true,
      ano,
      paginas_lidas: paginaAtual,
      linhas_total: totalLinhas,
      agregados: inseridos,
      min_alunos_turma: MIN_ALUNOS_TURMA,
    };
  }

  async function cursos(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureTurmasSchema();
    const ano = parseInt(req.query?.ano || new Date().getFullYear(), 10);
    const r = await query(`
      SELECT curso, SUM(total_alunos)::int AS total, SUM(total_ativos)::int AS ativos
      FROM chat_polos_turmas WHERE ano=$1
      GROUP BY curso ORDER BY total DESC
    `, [ano]);
    return { ok: true, ano, cursos: r.rows, min_alunos_turma: MIN_ALUNOS_TURMA };
  }

  async function statsSync(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensureTurmasSchema();
    const r = await query(`
      SELECT ano,
             COUNT(DISTINCT polo_chave)::int AS polos,
             COUNT(DISTINCT curso)::int AS cursos,
             SUM(total_alunos)::int AS alunos,
             SUM(total_ativos)::int AS ativos,
             MAX(atualizado_em) AS ultima
      FROM chat_polos_turmas GROUP BY ano ORDER BY ano DESC
    `);
    return { ok: true, min_alunos_turma: MIN_ALUNOS_TURMA, snapshots: r.rows };
  }

  fastify.post('/webhook/chat-polos-sync-matriculas', sync);
  fastify.get('/webhook/chat-polos-cursos', cursos);
  fastify.get('/webhook/chat-polos-sync-stats', statsSync);
}

export { MIN_ALUNOS_TURMA, normalizar };
