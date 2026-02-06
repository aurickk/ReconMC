const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

import { startCoordinatorServer } from './server.js';
import { logger } from './logger.js';

startCoordinatorServer(PORT, HOST, allowedOrigins).catch((err) => {
  logger.error(err);
  process.exit(1);
});
