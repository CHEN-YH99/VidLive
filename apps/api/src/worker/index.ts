import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/env.js';
import { ConversionService } from '../modules/conversions/conversion.service.js';

export async function startWorker(): Promise<void> {
  const config = loadConfig();

  if (!config.redisUrl) {
    throw new Error('redis-url-required-for-bullmq-worker');
  }

  const service = new ConversionService({
    config,
    runBullMqWorker: true,
  });

  process.once('SIGINT', () => {
    void service.close().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void service.close().finally(() => process.exit(0));
  });

  await new Promise<void>(() => {
    // Keep the worker process alive until it receives SIGINT/SIGTERM.
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
