import pg from 'pg';
import { config, hasDb } from '../config.js';

let pool = null;

export function getPool() {
  if (!hasDb()) return null;
  if (!pool) {
    const needSsl = /sslmode=require/i.test(config.databaseUrl);
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      ssl: needSsl ? { rejectUnauthorized: false } : false,
    });
    pool.on('error', (err) => {
      console.error('[pg pool error]', err.message);
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL não configurado');
  const result = await p.query(sql, params);
  return result;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
