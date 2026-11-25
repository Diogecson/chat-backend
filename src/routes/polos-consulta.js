// Consulta de polos mais proximos.
// - tabela chat_polos (seed via upload)
// - GET /webhook/chat-polos-proximos?cep=X ou ?cidade=X&uf=X → top N polos por distancia
// - POST /webhook/chat-polos-atualizar body {csv|dadosjs} → recarrega base (SUPER)
// - GET /webhook/chat-polos-stats → total, ativos, inativos, ultima_atualizacao
//
// Geolocalizacao: ViaCEP pra CEP → cidade/UF, Nominatim pra cidade → lat/lng.
// Caching em chat_polos_geocache 90d pra nao bater a cada busca.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const POLOS_JSON_PATH = path.join(__dirname, '..', '..', 'data', 'polos.json');

async function seedInicialSePrecisar() {
  try {
    const r = await query(`SELECT COUNT(*)::int AS n FROM chat_polos`);
    if (r.rows[0].n > 0) return;
    if (!fs.existsSync(POLOS_JSON_PATH)) return;
    const arr = JSON.parse(fs.readFileSync(POLOS_JSON_PATH, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return;
    console.log(`[polos-consulta] seed inicial: ${arr.length} polos do polos.json`);
    for (const p of arr) {
      await query(
        `INSERT INTO chat_polos (id, nome, cidade, uf, lat, lng, endereco, status, coordenadora, whatsapp, supervisor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [String(p.id), p.nome || '', p.cidade || '', (p.uf || '').toUpperCase(), p.la ?? null, p.lo ?? null, p.end || '', p.status || 'ATIVO', p.coord || '', p.whats || '', p.sup || '']
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[polos-consulta] seed inicial falhou:', err.message);
  }
}

let schemaEnsured = false;
async function ensurePolosSchema() {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_polos (
        id TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        cidade TEXT,
        uf VARCHAR(4),
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        endereco TEXT,
        status VARCHAR(30),
        coordenadora TEXT,
        whatsapp VARCHAR(30),
        supervisor TEXT,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_polos_uf ON chat_polos(uf)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_polos_cidade ON chat_polos(cidade)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_polos_status ON chat_polos(status)`);
    await query(`
      CREATE TABLE IF NOT EXISTS chat_polos_geocache (
        chave TEXT PRIMARY KEY,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        cidade TEXT,
        uf VARCHAR(4),
        logradouro TEXT,
        fonte TEXT,
        consultado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    schemaEnsured = true;
    await seedInicialSePrecisar();
  } catch (err) {
    console.error('[polos-consulta] ensurePolosSchema falhou:', err.message);
  }
}

// Haversine: distancia em km entre dois pontos lat/lng
function distKm(lat1, lng1, lat2, lng2) {
  const toRad = x => x * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Geocache lookup
async function geocacheGet(chave) {
  const r = await query(`SELECT * FROM chat_polos_geocache WHERE chave=$1 AND consultado_em > NOW() - INTERVAL '90 days' LIMIT 1`, [chave]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}
async function geocacheSet(chave, lat, lng, extra) {
  await query(
    `INSERT INTO chat_polos_geocache (chave, lat, lng, cidade, uf, logradouro, fonte)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (chave) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, cidade=EXCLUDED.cidade, uf=EXCLUDED.uf, logradouro=EXCLUDED.logradouro, fonte=EXCLUDED.fonte, consultado_em=NOW()`,
    [chave, lat, lng, extra.cidade || '', extra.uf || '', extra.logradouro || '', extra.fonte || '']
  ).catch(() => {});
}

// ViaCEP: CEP → {cidade, uf, logradouro, bairro}
async function viaCep(cep) {
  const clean = String(cep).replace(/\D/g, '');
  if (clean.length !== 8) return null;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
    const d = await r.json().catch(() => null);
    if (!d || d.erro) return null;
    return { cidade: d.localidade, uf: d.uf, logradouro: d.logradouro, bairro: d.bairro, cep: clean };
  } catch (_) { return null; }
}

// Nominatim: query texto → lat/lng (OSM, grátis, limite 1 req/s)
async function nominatim(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}&countrycodes=br`;
    const r = await fetch(url, { headers: { 'User-Agent': 'chat-backend-polos/1.0' } });
    const arr = await r.json().catch(() => []);
    if (!Array.isArray(arr) || !arr.length) return null;
    return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), display: arr[0].display_name };
  } catch (_) { return null; }
}

// Geolocaliza a partir do input (cep OU cidade+uf) usando cache
async function geolocalizar({ cep, cidade, uf }) {
  if (cep) {
    const chave = 'cep:' + cep.replace(/\D/g, '');
    const cached = await geocacheGet(chave);
    if (cached && cached.lat != null) return { lat: cached.lat, lng: cached.lng, cidade: cached.cidade, uf: cached.uf, fonte: 'cache' };
    const cepData = await viaCep(cep);
    if (!cepData) return null;
    const q = `${cepData.logradouro ? cepData.logradouro + ', ' : ''}${cepData.cidade}, ${cepData.uf}, Brasil`;
    const geo = await nominatim(q) || await nominatim(`${cepData.cidade}, ${cepData.uf}, Brasil`);
    if (!geo) return null;
    await geocacheSet(chave, geo.lat, geo.lng, { cidade: cepData.cidade, uf: cepData.uf, logradouro: cepData.logradouro, fonte: 'viacep+nominatim' });
    return { lat: geo.lat, lng: geo.lng, cidade: cepData.cidade, uf: cepData.uf, fonte: 'viacep+nominatim' };
  }
  if (cidade) {
    const ufU = (uf || '').toUpperCase();
    const chave = `cidade:${cidade.toLowerCase()}:${ufU}`;
    const cached = await geocacheGet(chave);
    if (cached && cached.lat != null) return { lat: cached.lat, lng: cached.lng, cidade: cached.cidade, uf: cached.uf, fonte: 'cache' };
    const q = ufU ? `${cidade}, ${ufU}, Brasil` : `${cidade}, Brasil`;
    const geo = await nominatim(q);
    if (!geo) return null;
    await geocacheSet(chave, geo.lat, geo.lng, { cidade, uf: ufU, fonte: 'nominatim' });
    return { lat: geo.lat, lng: geo.lng, cidade, uf: ufU, fonte: 'nominatim' };
  }
  return null;
}

// Parser do CSV de polos (header livre — tenta mapear por nome de coluna)
function parseCsvPolos(csvText) {
  const linhas = csvText.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (linhas.length < 2) return [];
  // Detecta separador
  const sep = linhas[0].includes(';') ? ';' : ',';
  const header = linhas[0].split(sep).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = (keys) => {
    for (const k of keys) {
      const i = header.findIndex(h => h === k || h.includes(k));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iId = col(['id', 'codigo', 'código']);
  const iNome = col(['nome', 'polo']);
  const iCidade = col(['cidade', 'municipio', 'município']);
  const iUf = col(['uf', 'estado']);
  const iEnd = col(['endereco', 'endereço']);
  const iStatus = col(['status', 'situacao', 'situação']);
  const iCoord = col(['coord', 'coordenad']);
  const iWhats = col(['whats', 'telefone', 'celular']);
  const iSup = col(['sup', 'gerente']);
  const iLat = col(['lat', 'la']);
  const iLng = col(['lng', 'lon', 'lo']);

  const out = [];
  for (let k = 1; k < linhas.length; k++) {
    const linha = linhas[k];
    // CSV simples — não quebra campos com virgula e aspas, mas OK pra base plana
    const vals = linha.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
    const id = iId >= 0 ? vals[iId] : '';
    if (!id) continue;
    out.push({
      id: String(id),
      nome: iNome >= 0 ? vals[iNome] : '',
      cidade: iCidade >= 0 ? vals[iCidade] : '',
      uf: iUf >= 0 ? (vals[iUf] || '').toUpperCase().substring(0, 4) : '',
      endereco: iEnd >= 0 ? vals[iEnd] : '',
      status: iStatus >= 0 ? vals[iStatus] : 'ATIVO',
      coordenadora: iCoord >= 0 ? vals[iCoord] : '',
      whatsapp: iWhats >= 0 ? vals[iWhats] : '',
      supervisor: iSup >= 0 ? vals[iSup] : '',
      lat: iLat >= 0 ? parseFloat(vals[iLat].replace(',', '.')) || null : null,
      lng: iLng >= 0 ? parseFloat(vals[iLng].replace(',', '.')) || null : null,
    });
  }
  return out;
}

// Parser de window.POLOS=[...] (formato do dados.js existente)
function parseDadosJs(texto) {
  const match = /window\.POLOS\s*=\s*(\[[\s\S]*?\]);?/m.exec(texto);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[1]);
    return arr.map(p => ({
      id: String(p.id || ''),
      nome: p.nome || '',
      cidade: p.cidade || '',
      uf: (p.uf || '').toUpperCase().substring(0, 4),
      endereco: p.end || p.endereco || '',
      status: p.status || 'ATIVO',
      coordenadora: p.coord || p.coordenadora || '',
      whatsapp: p.whats || p.whatsapp || '',
      supervisor: p.sup || p.supervisor || '',
      lat: typeof p.la === 'number' ? p.la : (typeof p.lat === 'number' ? p.lat : null),
      lng: typeof p.lo === 'number' ? p.lo : (typeof p.lng === 'number' ? p.lng : null),
    })).filter(p => p.id);
  } catch (_) {
    return [];
  }
}

export default async function polosConsultaRoutes(fastify) {
  async function stats(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensurePolosSchema();
    const r = await query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE UPPER(status)='ATIVO')::int AS ativos,
             COUNT(*) FILTER (WHERE UPPER(status)<>'ATIVO')::int AS inativos,
             COUNT(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int AS geolocalizados,
             MAX(atualizado_em) AS ultima_atualizacao
      FROM chat_polos
    `);
    return { ok: true, stats: r.rows[0] };
  }

  async function proximos(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensurePolosSchema();
    const q = req.query || {};
    const limit = Math.min(parseInt(q.limit || '8') || 8, 30);
    const curso = q.curso ? String(q.curso).trim() : '';
    const soComTurma = q.so_com_turma === 'true';
    const minAlunos = parseInt(q.min_alunos || process.env.MIN_ALUNOS_TURMA || '15', 10);
    const ano = parseInt(q.ano || new Date().getFullYear(), 10);

    let origem = null;
    if (q.lat && q.lng) {
      origem = { lat: parseFloat(q.lat), lng: parseFloat(q.lng), fonte: 'direto' };
    } else if (q.cep || q.cidade) {
      origem = await geolocalizar({ cep: q.cep, cidade: q.cidade, uf: q.uf });
      if (!origem) return reply.code(400).send({ ok: false, erro: 'não consegui geolocalizar o CEP/cidade' });
    } else {
      return reply.code(400).send({ ok: false, erro: 'informe cep, cidade ou lat+lng' });
    }

    const soAtivos = q.incluir_inativos === 'true' ? '' : `AND UPPER(status)='ATIVO'`;
    const r = await query(`
      SELECT id, nome, cidade, uf, lat, lng, endereco, status, coordenadora, whatsapp, supervisor
      FROM chat_polos
      WHERE lat IS NOT NULL AND lng IS NOT NULL ${soAtivos}
    `);

    // Agrega matriculas: total geral por polo + total no curso (se curso informado)
    let totaisPorPolo = new Map(); // polo_chave → {total, ativos, nocurso, nocurso_ativos}
    try {
      // Total de alunos por polo (independe do curso)
      const tp = await query(`
        SELECT polo_chave, SUM(total_alunos)::int AS total, SUM(total_ativos)::int AS ativos
        FROM chat_polos_turmas WHERE ano=$1 GROUP BY polo_chave
      `, [ano]);
      for (const row of tp.rows) {
        totaisPorPolo.set(String(row.polo_chave).trim().toLowerCase(), { total: row.total, ativos: row.ativos, nocurso: 0, nocurso_ativos: 0 });
      }
      if (curso) {
        // Match aproximado por LIKE (curso pode vir com nome parcial)
        const tc = await query(`
          SELECT polo_chave, total_alunos, total_ativos, curso
          FROM chat_polos_turmas
          WHERE ano=$1 AND LOWER(curso) LIKE $2
        `, [ano, '%' + String(curso).toLowerCase() + '%']);
        for (const row of tc.rows) {
          const k = String(row.polo_chave).trim().toLowerCase();
          const cur = totaisPorPolo.get(k) || { total: 0, ativos: 0, nocurso: 0, nocurso_ativos: 0 };
          cur.nocurso += row.total_alunos;
          cur.nocurso_ativos += row.total_ativos;
          totaisPorPolo.set(k, cur);
        }
      }
    } catch (err) {
      console.warn('[polos-consulta] agg turmas falhou:', err.message);
    }

    // Enriquece cada polo. Match: polo_chave pode ser id do polo OU nome — tenta ambos
    const polos = r.rows.map(p => {
      const dist = Math.round(distKm(origem.lat, origem.lng, p.lat, p.lng) * 10) / 10;
      // Tenta match com id, depois nome/cidade
      const candidatos = [
        String(p.id || '').toLowerCase(),
        String(p.nome || '').toLowerCase(),
        String(p.cidade || '').toLowerCase(),
      ].filter(Boolean);
      let agg = null;
      for (const c of candidatos) {
        if (totaisPorPolo.has(c)) { agg = totaisPorPolo.get(c); break; }
      }
      if (!agg) {
        // Busca por substring (nome do polo contem a chave)
        for (const [k, v] of totaisPorPolo.entries()) {
          if (candidatos.some(c => c.includes(k) || k.includes(c))) { agg = v; break; }
        }
      }
      const total_alunos = agg?.total || 0;
      const total_ativos = agg?.ativos || 0;
      const alunos_curso = agg?.nocurso || 0;
      const alunos_curso_ativos = agg?.nocurso_ativos || 0;
      const turma_viavel = curso ? (alunos_curso_ativos >= minAlunos) : (total_ativos >= minAlunos);
      return {
        ...p,
        distancia_km: dist,
        total_alunos, total_ativos,
        alunos_curso, alunos_curso_ativos,
        turma_viavel,
      };
    });

    let filtrados = polos;
    if (curso && soComTurma) filtrados = polos.filter(p => p.alunos_curso_ativos >= minAlunos);
    filtrados.sort((a, b) => a.distancia_km - b.distancia_km);
    return {
      ok: true, origem, polos: filtrados.slice(0, limit),
      total_base: r.rowCount, curso, min_alunos_turma: minAlunos, ano,
    };
  }

  async function atualizar(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensurePolosSchema();
    const b = req.body || {};
    const papel = String(b.papel || '').toUpperCase();
    if (papel !== 'SUPER') {
      return reply.code(403).send({ ok: false, erro: 'só SUPER pode atualizar a base de polos' });
    }
    const conteudo = String(b.conteudo || b.csv || b.dadosjs || '').trim();
    if (!conteudo) return reply.code(400).send({ ok: false, erro: 'conteudo vazio' });
    const substituir = b.substituir === true || b.substituir === 'true';

    // Detecta formato: dados.js (window.POLOS=...) ou CSV
    let polos;
    if (/window\.POLOS\s*=/.test(conteudo)) {
      polos = parseDadosJs(conteudo);
    } else {
      polos = parseCsvPolos(conteudo);
    }
    if (!polos.length) return reply.code(400).send({ ok: false, erro: 'não extraí nenhum polo (verifique o formato)' });

    if (substituir) {
      await query(`DELETE FROM chat_polos`);
    }
    let inserted = 0, updated = 0;
    for (const p of polos) {
      const r = await query(
        `INSERT INTO chat_polos (id, nome, cidade, uf, lat, lng, endereco, status, coordenadora, whatsapp, supervisor, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (id) DO UPDATE SET
           nome=EXCLUDED.nome, cidade=EXCLUDED.cidade, uf=EXCLUDED.uf,
           lat=COALESCE(EXCLUDED.lat, chat_polos.lat),
           lng=COALESCE(EXCLUDED.lng, chat_polos.lng),
           endereco=EXCLUDED.endereco, status=EXCLUDED.status,
           coordenadora=EXCLUDED.coordenadora, whatsapp=EXCLUDED.whatsapp,
           supervisor=EXCLUDED.supervisor, atualizado_em=NOW()
         RETURNING (xmax=0) AS inserted`,
        [p.id, p.nome, p.cidade, p.uf, p.lat, p.lng, p.endereco, p.status, p.coordenadora, p.whatsapp, p.supervisor]
      );
      if (r.rows[0]?.inserted) inserted++; else updated++;
    }
    console.log(`[polos-consulta] papel=${papel} ins=${inserted} upd=${updated} subst=${substituir}`);
    return { ok: true, inserted, updated, total: polos.length, substituiu: substituir };
  }

  async function detalhe(req, reply) {
    if (!hasDb()) return reply.code(503).send({ ok: false, erro: 'sem DB' });
    await ensurePolosSchema();
    const id = String(req.params.id);
    const r = await query(`SELECT * FROM chat_polos WHERE id=$1 LIMIT 1`, [id]);
    if (!r.rows.length) return reply.code(404).send({ ok: false, erro: 'polo não encontrado' });
    return { ok: true, polo: r.rows[0] };
  }

  fastify.get('/webhook/chat-polos-stats', stats);
  fastify.get('/webhook/chat-polos-proximos', proximos);
  fastify.post('/webhook/chat-polos-atualizar', atualizar);
  fastify.get('/webhook/chat-polos-detalhe/:id', detalhe);
}
