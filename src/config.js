import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3100'),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseUrl: process.env.DATABASE_URL || '',
  queueDatabaseUrl: process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL || '',
  metaApiVersion: process.env.META_API_VERSION || 'v26.0',
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
  // Se setado, TODAS as rotas forçam filtro por essa conta (modo "instância dedicada")
  // Ex: CONTA_FIXA=meta_1316884364850837 → tudo filtrado pra VLC, nenhum vazamento de outra conta
  contaFixa: process.env.CONTA_FIXA || '',
  // Label opcional pra UI mostrar "qual conta" (ex: "VLC Educacional Curitiba")
  contaLabel: process.env.CONTA_LABEL || '',
};

export const hasDb = () => !!config.databaseUrl;
