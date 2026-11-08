// Worker de disparos: processa a fila "disparos" com concurrency=1
// Vai ser plugado quando a rota /api/disparos/criar começar a enfileirar
import { getBoss, QUEUES, stopBoss } from '../services/queue.js';
import { config } from '../config.js';

async function main() {
  const boss = await getBoss();
  if (!boss) {
    console.error('QUEUE_DATABASE_URL não configurado — worker não pode subir');
    process.exit(1);
  }

  console.log(`[worker-disparos] subiu. DRY_RUN=${config.dryRun}`);

  await boss.work(
    QUEUES.DISPAROS,
    { teamSize: 1, teamConcurrency: 1 }, // SEMPRE 1 msg por vez
    async (job) => {
      const { msg_id, telefone, template_name } = job.data || {};
      console.log(`[worker] processando msg_id=${msg_id} tel=${telefone} tpl=${template_name}`);
      // TODO: ler conta do banco, chamar Meta, atualizar chat_disparos_msgs
      // Esqueleto por enquanto: só loga
      return { ok: true, skeleton: true };
    }
  );
}

async function shutdown(signal) {
  console.log(`[worker-disparos] ${signal} — encerrando...`);
  try {
    await stopBoss();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[worker-disparos] erro fatal', err);
  process.exit(1);
});
