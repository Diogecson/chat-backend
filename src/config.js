import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3100'),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseUrl: process.env.DATABASE_URL || '',
  queueDatabaseUrl: process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL || '',
  metaApiVersion: process.env.META_API_VERSION || 'v26.0',
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
};

export const hasDb = () => !!config.databaseUrl;
