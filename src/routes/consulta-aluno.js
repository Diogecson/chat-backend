// /api/chat/consulta-aluno — consulta ex-aluno (ou aluno ativo) na API da TI UniFECAF
// Body: { tipo: 'ra' | 'cpf', valor: string }
// - RA: filtro direto na API (ra_busca).
// - CPF: API não tem filtro; puxa últimos N anos e cruza pelos últimos 4 dígitos
//   (API devolve CPF mascarado tipo "***.***.*69-60").
// Resposta: { ok, alunos: [{...linha da API agrupada por matricula_id}] }

const CORE_API_BASE = process.env.CORE_API_BASE || 'https://core.data.unifecaf.edu.br/api/v1';
const CORE_API_KEY = process.env.CORE_API_KEY || '';
const ANOS_BUSCA_CPF = parseInt(process.env.CORE_ANOS_BUSCA_CPF || '3', 10);

function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

// Extrai só os dígitos visíveis do CPF mascarado do core: "***.***.*69-60" → "6960"
function cpfSufixoVisivel(cpfMasc) {
  const m = String(cpfMasc || '').match(/(\d+)-(\d+)$/);
  if (!m) return '';
  return (m[1] + m[2]).slice(-4); // últimos 4 dígitos
}

async function fetchLinhas({ ra_busca, ano, limite = 1000, pagina = 1 }) {
  const qs = new URLSearchParams();
  if (ra_busca) qs.set('ra_busca', ra_busca);
  if (ano) qs.set('ano', String(ano));
  qs.set('limite', String(limite));
  qs.set('pagina', String(pagina));
  const url = `${CORE_API_BASE}/dados/matriculas/lista?${qs.toString()}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'X-API-Key': CORE_API_KEY, 'Accept': 'application/json' },
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch (_) {
    throw new Error(`Resposta não-JSON do core: ${txt.substring(0, 180)}`);
  }
  if (!r.ok) {
    throw new Error(data?.detail || data?.erro || `HTTP ${r.status} do core`);
  }
  return Array.isArray(data?.linhas) ? data.linhas : [];
}

function agruparPorMatricula(linhas) {
  const map = new Map();
  for (const l of linhas) {
    const mid = l.matricula_id || `${l.cpf}|${l.curso_id}|${l.dt_captacao}`;
    if (!map.has(mid)) {
      map.set(mid, { ...l, contratos: [] });
    }
    const alvo = map.get(mid);
    if (l.contrato_id) {
      alvo.contratos.push({
        contrato_id: l.contrato_id,
        situacao_contrato: l.situacao_contrato,
        taxa_paga: l.taxa_paga,
        mensalidade_paga: l.mensalidade_paga,
        valor_taxa_adesao_paga: l.valor_taxa_adesao_paga,
        valor_primeira_mensalidade_paga: l.valor_primeira_mensalidade_paga,
        dt_pagamento_taxa: l.dt_pagamento_taxa,
        dt_pagamento_mensalidade: l.dt_pagamento_mensalidade,
        numero_parcela_mensalidade: l.numero_parcela_mensalidade,
        tipo_parcela_paga: l.tipo_parcela_paga,
        tipo_debito_taxa: l.tipo_debito_taxa,
        tipo_debito_mensalidade: l.tipo_debito_mensalidade,
      });
    }
  }
  return Array.from(map.values());
}

export default async function consultaAlunoRoutes(fastify) {
  async function handle(req, reply) {
    if (!CORE_API_KEY) {
      reply.code(500);
      return { ok: false, erro: 'CORE_API_KEY não configurada no backend' };
    }
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
    const tipo = String(b.tipo || '').toLowerCase();
    const valor = String(b.valor || '').trim();
    if (!['ra', 'cpf'].includes(tipo)) {
      reply.code(400); return { ok: false, erro: "tipo deve ser 'ra' ou 'cpf'" };
    }
    if (!valor) { reply.code(400); return { ok: false, erro: 'valor obrigatório' }; }

    try {
      let linhas = [];
      if (tipo === 'ra') {
        const ra = onlyDigits(valor);
        if (!ra) { reply.code(400); return { ok: false, erro: 'RA inválido' }; }
        // Busca sem filtrar ano (RA é único no sistema)
        linhas = await fetchLinhas({ ra_busca: ra, limite: 1000 });
        // ra_busca faz "parte do RA": filtra pra match exato
        linhas = linhas.filter(l => String(l.ra || '') === ra);
      } else {
        const cpf = onlyDigits(valor);
        if (cpf.length !== 11) { reply.code(400); return { ok: false, erro: 'CPF deve ter 11 dígitos' }; }
        const sufixo = cpf.slice(-4);
        // Puxa últimos N anos, uma chamada por ano
        const anoAtual = new Date().getFullYear();
        const anos = [];
        for (let i = 0; i < ANOS_BUSCA_CPF; i++) anos.push(anoAtual - i);
        for (const ano of anos) {
          const lhs = await fetchLinhas({ ano, limite: 1000 });
          linhas = linhas.concat(lhs);
        }
        // Filtra pelos últimos 4 dígitos visíveis do CPF
        linhas = linhas.filter(l => cpfSufixoVisivel(l.cpf) === sufixo);
      }

      const alunos = agruparPorMatricula(linhas);
      // Ordena da mais recente pra mais antiga
      alunos.sort((a, b) => {
        const da = new Date(a.dt_matricula || a.dt_captacao || 0).getTime();
        const db = new Date(b.dt_matricula || b.dt_captacao || 0).getTime();
        return db - da;
      });
      return { ok: true, total: alunos.length, alunos };
    } catch (err) {
      reply.code(502);
      return { ok: false, erro: err.message || 'falha no core' };
    }
  }
  fastify.post('/api/chat/consulta-aluno', handle);
  fastify.post('/webhook/chat-consulta-aluno', handle);
}
