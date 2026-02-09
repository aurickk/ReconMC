import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import { runMigrations } from './db/migrate.js';
import { taskRoutes } from './routes/tasks.js';
import { serverRoutes } from './routes/servers.js';
import { queueRoutes } from './routes/queue.js';
import { accountRoutes } from './routes/accounts.js';
import { proxyRoutes } from './routes/proxies.js';
import { agentRoutes } from './routes/agents.js';
import { logger } from './logger.js';
import { requireApiKey, isAuthDisabled } from './middleware/auth.js';
import { isRedisAvailable, closeRedis } from './db/redis.js';
import { createDb, closeDb } from './db/index.js';
import { startStuckTaskRecovery } from './services/redisQueueService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getCorsOrigin(allowedOrigins: string[] | undefined) {
  if (allowedOrigins?.length) {
    // Allow all origins if * is in the list (dev mode)
    if (allowedOrigins.includes('*')) {
      return true;
    }
    return (reqOrigin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      cb(null, !reqOrigin || allowedOrigins.includes(reqOrigin));
    };
  }
  // Reject all requests if no origins configured (more secure for production)
  return false;
}

export async function createCoordinatorServer(allowedOrigins?: string[]) {
  // Configure logger to only log errors and slow requests (>1s)
  const fastify = Fastify({
    logger: {
      level: 'warn', // Only log warnings and errors
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    },
    trustProxy: true,
    disableRequestLogging: true, // Disable automatic request/response logging
  });

  await fastify.register(cors, {
    origin: getCorsOrigin(allowedOrigins),
    credentials: true
  });

  // Enable response compression (gzip, deflate) for JSON payloads
  await fastify.register(compress, { encodings: ['gzip', 'deflate'] });

  // Register /api/health BEFORE other routes so it stays public (no auth required)
  fastify.get('/api/health', async (_request, reply) => {
    const redisAvailable = isRedisAvailable();
    return reply.send({
      status: 'ok',
      service: 'coordinator',
      redis: redisAvailable ? 'ok' : 'unavailable',
    });
  });

  // Auth status endpoint (public) - lets frontend know if auth is required
  fastify.get('/api/auth/status', async (_request, reply) => {
    return reply.send({ authRequired: !isAuthDisabled() });
  });

  // Register agent routes BEFORE auth (agents need to register without API key)
  // Agent registration is internal (Docker network) so this is safe
  await fastify.register(agentRoutes, { prefix: '/api' });

  // Register task routes (public for agents, GET logs are protected internally)
  await fastify.register(taskRoutes, { prefix: '/api' });

  // Register queue routes (public for agents)
  await fastify.register(queueRoutes, { prefix: '/api' });

  // Register protected routes (require API key)
  await fastify.register(async function (fastify) {
    fastify.addHook('onRequest', requireApiKey);
    await fastify.register(serverRoutes, { prefix: '/api' });
    await fastify.register(accountRoutes, { prefix: '/api' });
    await fastify.register(proxyRoutes, { prefix: '/api' });
  });

  // Serve dashboard static files from dashboard/dist
  const dashboardDist = path.join(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    await fastify.register(fastifyStatic, {
      root: dashboardDist,
      prefix: '/',
      wildcard: false,
    });

    // Serve index.html for all non-API routes (SPA support)
    fastify.setNotFoundHandler((request, reply) => {
      if (!request.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not Found', message: 'Route not found' });
    });

    logger.info(`Dashboard static files served from ${dashboardDist}`);
  } else {
    logger.warn('Dashboard dist folder not found, serving API only');
  }

  // Sanitize error messages - don't expose raw errors in production
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    const isProduction = process.env.NODE_ENV === 'production';
    reply.code(500).send({
      error: 'Internal Server Error',
      message: isProduction ? 'An error occurred' : String(error)
    });
  });

  return fastify;
}

export async function startCoordinatorServer(
  port: number,
  host: string,
  allowedOrigins?: string[]
): Promise<void> {
  await runMigrations();
  const server = await createCoordinatorServer(allowedOrigins);
  await server.listen({ port, host });
  logger.info(`Coordinator listening on http://${host}:${port}`);

  // Start periodic recovery of tasks stuck in "processing" state
  const db = createDb();
  const recoveryInterval = startStuckTaskRecovery(db);

  // Graceful shutdown: close connections and drain in-flight requests
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Stop accepting new connections and wait for in-flight requests to finish
    try {
      await server.close();
      logger.info('Fastify server closed');
    } catch (err) {
      logger.error('Error closing Fastify server:', err);
    }

    // Stop the stuck-task recovery interval
    clearInterval(recoveryInterval);

    // Close Redis and database connections
    await closeRedis();
    await closeDb();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
