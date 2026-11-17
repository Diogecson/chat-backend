// Polos: consulta o polo UniFECAF mais proximo de um CEP.
// Base: data/polos.json (extraido do Mapa de Distancias — 293 polos ATIVOS).
// Fluxo:
//   1. BrasilAPI v2 (CEP -> lat/lng/cidade). Se falhar, ViaCEP (so cidade/UF).
//   2. Haversine contra todos os polos ativos.
//   3. Retorna {nome, end, cidade, uf, distancia_km}.
// Usada pela IA Black Friday via tool HTTP no Agent n8n.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const POLOS_PATH = path.join(__dirname, '..', '..', 'data', 'polos.json');

let POLOS = [];
try {
  POLOS = JSON.parse(fs.readFileSync(POLOS_PATH, 'utf8'));
  console.log(`[polos] carregados ${POLOS.length} polos ativos`);
} catch (err) {
  console.error('[polos] falhou ao carregar', POLOS_PATH, err.message);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

async function resolveCep(cepRaw) {
  const cep = String(cepRaw || '').replace(/\D/g, '');
  if (cep.length !== 8) return { erro: 'cep invalido' };

  // Tenta BrasilAPI v2 (tem coordenadas)
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'chat-backend' },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      const la = j?.location?.coordinates?.latitude;
      const lo = j?.location?.coordinates?.longitude;
      return {
        cep, cidade: j.city, uf: j.state, bairro: j.neighborhood, rua: j.street,
        la: la ? Number(la) : null,
        lo: lo ? Number(lo) : null,
        fonte: 'brasilapi',
      };
    }
  } catch (err) {
    console.warn('[polos] BrasilAPI', err.message);
  }

  // Fallback ViaCEP (sem coordenadas)
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      if (!j.erro) {
        return {
          cep, cidade: j.localidade, uf: j.uf, bairro: j.bairro, rua: j.logradouro,
          la: null, lo: null, fonte: 'viacep',
        };
      }
    }
  } catch (err) {
    console.warn('[polos] ViaCEP', err.message);
  }

  return { erro: 'cep nao encontrado' };
}

function escolherPolo(info, max = 3) {
  if (!POLOS.length) return [];

  // Se tem coordenadas, haversine global
  if (info.la && info.lo) {
    return POLOS
      .map(p => ({ ...p, dist: haversineKm(info.la, info.lo, p.la, p.lo) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, max);
  }

  // Sem coordenadas: filtra por UF e tenta match de cidade
  const cidadeNorm = normalizar(info.cidade);
  const mesmoUf = POLOS.filter(p => p.uf === info.uf);
  const doBairro = mesmoUf.filter(p => normalizar(p.cidade) === cidadeNorm);
  if (doBairro.length) return doBairro.slice(0, max).map(p => ({ ...p, dist: null }));
  return mesmoUf.slice(0, max).map(p => ({ ...p, dist: null }));
}

export default async function polosRoutes(fastify) {
  // POST + GET: /webhook/polo-por-cep
  const handler = async (req, reply) => {
    const cep = String(
      (req.body && req.body.cep) || req.query?.cep || ''
    ).replace(/\D/g, '');
    if (!cep) return reply.code(400).send({ ok: false, erro: 'cep obrigatorio' });

    const info = await resolveCep(cep);
    if (info.erro) return reply.code(404).send({ ok: false, erro: info.erro, cep });

    const polos = escolherPolo(info, 3);
    if (!polos.length) {
      return {
        ok: true, cep: info.cep, cidade: info.cidade, uf: info.uf,
        tem_polo: false,
        mensagem: `Nao achei polo UniFECAF proximo (${info.cidade}/${info.uf}). O consultor humano confirma.`,
      };
    }

    const p = polos[0];
    return {
      ok: true,
      cep: info.cep,
      cidade_cliente: info.cidade,
      uf_cliente: info.uf,
      polo: {
        id: p.id,
        nome: p.nome,
        cidade: p.cidade,
        uf: p.uf,
        endereco: p.end,
        distancia_km: p.dist != null ? Math.round(p.dist) : null,
      },
      alternativas: polos.slice(1).map(x => ({
        nome: x.nome, cidade: x.cidade, uf: x.uf, endereco: x.end,
        distancia_km: x.dist != null ? Math.round(x.dist) : null,
      })),
      fonte_cep: info.fonte,
    };
  };

  fastify.post('/webhook/polo-por-cep', handler);
  fastify.get('/webhook/polo-por-cep', handler);

  // Diag: quantos polos carregados
  fastify.get('/webhook/polos-status', async () => ({
    ok: true, total_polos: POLOS.length, path: POLOS_PATH,
  }));
}
