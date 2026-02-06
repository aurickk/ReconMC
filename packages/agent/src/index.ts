import { runWorker } from './worker.js';
import { logger } from './logger.js';

runWorker().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
