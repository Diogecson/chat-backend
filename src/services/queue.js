import PgBoss from 'pg-boss';
import { config } from '../config.js';

let boss = null;

export async function getBoss() {
  if (!config.queueDatabaseUrl) return null;
  if (!boss) {
    boss = new PgBoss({
      connectionString: config.queueDatabaseUrl,
      schema: 'pgboss',
      retryLimit: 3,
      retryDelay: 60,
      archiveCompletedAfterSeconds: 60 * 60 * 24,
      deleteAfterDays: 7,
    });
    boss.on('error', (err) => console.error('[pg-boss error]', err.message));
    await boss.start();
  }
  return boss;
}

export async function stopBoss() {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 5000 });
    boss = null;
  }
}

// Nomes das filas (constantes pra não digitar errado em dois lugares)
export const QUEUES = {
  DISPAROS: 'disparos',
};
