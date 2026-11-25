// Middleware de log de acesso (MVP seguranca).
// Agrega por (minuto, ip, rota, metodo) pra nao estourar o banco.
// Buffer in-memory flushado a cada 5s.
import { query } from './db.js';
import { hasDb } from '../config.js';

let schemaEnsured = false;
export async function ensureAcessoSchema() {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_acesso_log (
        minuto TIMESTAMPTZ NOT NULL,
        ip TEXT NOT NULL,
        rota TEXT NOT NULL,
        metodo VARCHAR(10) NOT NULL,
        count INT NOT NULL DEFAULT 0,
        status_ok INT NOT NULL DEFAULT 0,
        status_401 INT NOT NULL DEFAULT 0,
        status_403 INT NOT NULL DEFAULT 0,
        status_404 INT NOT NULL DEFAULT 0,
        status_5xx INT NOT NULL DEFAULT 0,
        ultimo_user_agent TEXT,
        ultimo_usuario VARCHAR(80),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (minuto, ip, rota, metodo)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_acesso_minuto ON chat_acesso_log(minuto DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_acesso_ip ON chat_acesso_log(ip)`);
    await query(`
      CREATE TABLE IF NOT EXISTS chat_acesso_ip_info (
        ip TEXT PRIMARY KEY,
        hostname TEXT,
        pais VARCHAR(80),
        cidade VARCHAR(120),
        org TEXT,
        consultado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    schemaEnsured = true;
  } catch (err) {
    console.error('[acesso-log] ensureAcessoSchema falhou:', err.message);
  }
}

// Buffer: Map chave -> {count, status_ok, status_401, status_403, status_404, status_5xx, ua, usuario}
const buffer = new Map();

// Rotas ignoradas no log (muito ruido, sem valor pra seguranca)
const ROTAS_IGNORADAS = new Set([
  '/health',
  '/health/db',
  '/favicon.ico',
]);
function deveIgnorar(url) {
  if (!url) return true;
  const semQuery = url.split('?')[0];
  if (ROTAS_IGNORADAS.has(semQuery)) return true;
  // Ignora arquivos estaticos (css/js/img/font)
  if (/\.(css|js|map|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$/i.test(semQuery)) return true;
  return false;
}

// Normaliza rota: tira querystring, trunca em 200 chars
function normalizarRota(url) {
  if (!url) return '';
  const semQuery = url.split('?')[0];
  return semQuery.substring(0, 200);
}

function classeStatus(st) {
  if (!st) return 'ok';
  if (st === 401) return 'status_401';
  if (st === 403) return 'status_403';
  if (st === 404) return 'status_404';
  if (st >= 500) return 'status_5xx';
  return 'status_ok';
}

export function registrarAcesso(req, reply, usuario) {
  if (deveIgnorar(req.url)) return;
  const ip = (req.ip || '').toString().substring(0, 64);
  const rota = normalizarRota(req.url);
  const metodo = (req.method || 'GET').substring(0, 10);
  const minuto = new Date();
  minuto.setSeconds(0, 0);
  const key = `${minuto.toISOString()}|${ip}|${rota}|${metodo}`;
  let cur = buffer.get(key);
  if (!cur) {
    cur = { count: 0, status_ok: 0, status_401: 0, status_403: 0, status_404: 0, status_5xx: 0, ua: '', usuario: '' };
    buffer.set(key, cur);
  }
  cur.count++;
  cur[classeStatus(reply.statusCode)]++;
  const ua = String(req.headers?.['user-agent'] || '').substring(0, 300);
  if (ua) cur.ua = ua;
  if (usuario) cur.usuario = String(usuario).substring(0, 80);
}

async function flush() {
  if (!hasDb() || buffer.size === 0) return;
  const linhas = [...buffer.entries()];
  buffer.clear();
  // Monta UPSERT batch
  try {
    for (const [key, v] of linhas) {
      const [minutoIso, ip, rota, metodo] = key.split('|');
      await query(
        `INSERT INTO chat_acesso_log
          (minuto, ip, rota, metodo, count, status_ok, status_401, status_403, status_404, status_5xx, ultimo_user_agent, ultimo_usuario, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (minuto, ip, rota, metodo) DO UPDATE SET
           count = chat_acesso_log.count + EXCLUDED.count,
           status_ok = chat_acesso_log.status_ok + EXCLUDED.status_ok,
           status_401 = chat_acesso_log.status_401 + EXCLUDED.status_401,
           status_403 = chat_acesso_log.status_403 + EXCLUDED.status_403,
           status_404 = chat_acesso_log.status_404 + EXCLUDED.status_404,
           status_5xx = chat_acesso_log.status_5xx + EXCLUDED.status_5xx,
           ultimo_user_agent = COALESCE(NULLIF(EXCLUDED.ultimo_user_agent,''), chat_acesso_log.ultimo_user_agent),
           ultimo_usuario = COALESCE(NULLIF(EXCLUDED.ultimo_usuario,''), chat_acesso_log.ultimo_usuario),
           atualizado_em = NOW()`,
        [minutoIso, ip, rota, metodo, v.count, v.status_ok, v.status_401, v.status_403, v.status_404, v.status_5xx, v.ua, v.usuario]
      );
    }
  } catch (err) {
    console.error('[acesso-log] flush erro:', err.message);
  }
}

let flushInterval = null;
export function startAcessoLogCron() {
  if (flushInterval) return;
  flushInterval = setInterval(() => { flush().catch(() => {}); }, 5000);
  // Retention: apaga logs > 7 dias uma vez por hora
  setInterval(async () => {
    if (!hasDb()) return;
    try {
      await query(`DELETE FROM chat_acesso_log WHERE minuto < NOW() - INTERVAL '7 days'`);
      await query(`DELETE FROM chat_acesso_ip_info WHERE consultado_em < NOW() - INTERVAL '30 days'`);
    } catch (err) {
      console.error('[acesso-log] retention erro:', err.message);
    }
  }, 60 * 60 * 1000);
}

export function stopAcessoLogCron() {
  if (flushInterval) { clearInterval(flushInterval); flushInterval = null; }
}
