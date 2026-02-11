import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  addToQueue,
  listServers,
  getServer,
  deleteServer,
  deleteScanHistory,
  type AddToQueueResult,
} from '../services/redisQueueService.js';
import { eq, or, and, sql } from 'drizzle-orm';
import { servers, scanQueue, taskLogs } from '../db/schema.js';
import { getRedisClient, safeRedisCommand, REDIS_KEYS } from '../db/redis.js';
import { requireApiKey } from '../middleware/auth.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function serverRoutes(fastify: FastifyInstance) {
  const db = createDb();

  /**
   * POST /api/servers/add
   * Add server(s) to the scan queue
   * Returns { added, skipped, queued[] }
   */
  fastify.post<{ Body: { servers: string[] } }>(
    '/servers/add',
    async (request, reply) => {
      const { servers: serverList } = request.body ?? {};
      if (!Array.isArray(serverList) || serverList.length === 0) {
        return reply.code(400).send({ error: 'servers array is required and must not be empty' });
      }

      try {
        const result = await addToQueue(db, { servers: serverList });
        return reply.code(201).send(result);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to add servers', message: String(err) });
      }
    }
  );

  /**
   * GET /api/servers
   * List all servers with latest results
   * Query params: limit (default 100), offset (default 0)
   */
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/servers',
    async (request, reply) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
      const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

      try {
        const serverList = await listServers(db, { limit, offset });
        return reply.send(serverList);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to list servers', message: String(err) });
      }
    }
  );

  /**
   * GET /api/servers/by-address/:address
   * Get server by address (hostname:port, hostname, or IP:port)
   * This is useful for Discord bot to find scan results without pagination
   * With IP-based grouping, this will return the server if any hostname or the IP matches
   */
  fastify.get<{ Params: { address: string } }>(
    '/servers/by-address/:address',
    async (request, reply) => {
      try {
        const address = request.params.address;
        // Parse address to handle both "host:port" and "host" formats
        const [hostPart, portPart] = address.split(':');
        const host = hostPart ?? address;
        const port = portPart ? parseInt(portPart, 10) : 25565;

        // Import resolveServerIp to resolve hostname to IP for lookup
        const { resolveServerIp } = await import('../services/ipResolver.js');

        let resolvedIp = host;
        try {
          // Try to resolve to IP if hostname was provided
          resolvedIp = await resolveServerIp(host);
        } catch {
          // Resolution failed, use original host
          resolvedIp = host;
        }

        // Match by resolvedIp + port (IP-based grouping)
        // Also check if hostname is in the hostnames array
        const [server] = await db
          .select()
          .from(servers)
          .where(
            or(
              // Direct IP + port match
              and(
                eq(servers.resolvedIp, resolvedIp),
                eq(servers.port, port)
              ),
              // Or hostname in hostnames array + port match
              sql<`${string}:${number}`>`(${servers.hostnames})::jsonb ? ${host} AND ${servers.port} = ${port}`
            )
          )
          .limit(1);

        if (!server) {
          return reply.code(404).send({ error: 'Server not found' });
        }

        // Return server with all hostnames
        return reply.send(server);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to get server', message: String(err) });
      }
    }
  );

  /**
   * GET /api/servers/:id
   * Get server with full scan history
   */
  fastify.get<{ Params: { id: string } }>(
    '/servers/:id',
    async (request, reply) => {
      if (!request.params.id || !UUID_REGEX.test(request.params.id)) {
        return reply.code(400).send({ error: 'Invalid server ID format' });
      }
      try {
        const server = await getServer(db, request.params.id);
        if (!server) {
          return reply.code(404).send({ error: 'Server not found' });
        }
        return reply.send(server);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to get server', message: String(err) });
      }
    }
  );

  /**
   * DELETE /api/servers/:id
   * Delete a server record (protected)
   */
  fastify.delete<{ Params: { id: string } }>(
    '/servers/:id',
    { onRequest: requireApiKey },
    async (request, reply) => {
      if (!request.params.id || !UUID_REGEX.test(request.params.id)) {
        return reply.code(400).send({ error: 'Invalid server ID format' });
      }
      try {
        const deleted = await deleteServer(db, request.params.id);
        if (!deleted) {
          return reply.code(404).send({ error: 'Server not found' });
        }
        return reply.send({ message: 'Server deleted successfully' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete server', message: String(err) });
      }
    }
  );

  /**
   * DELETE /api/servers/:id/scan/:timestamp
   * Delete a specific scan from server's history (protected)
   */
  fastify.delete<{ Params: { id: string; timestamp: string } }>(
    '/servers/:id/scan/:timestamp',
    { onRequest: requireApiKey },
    async (request, reply) => {
      try {
        const deleted = await deleteScanHistory(db, request.params.id, decodeURIComponent(request.params.timestamp));
        if (!deleted) {
          return reply.code(404).send({ error: 'Scan entry not found' });
        }
        return reply.send({ message: 'Scan deleted successfully' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete scan', message: String(err) });
      }
    }
  );

  /**
   * DELETE /api/servers/purge
   * Delete ALL servers, scan queue, and task logs (protected)
   * Does NOT affect accounts, proxies, or agents
   */
  fastify.delete(
    '/servers/purge',
    { onRequest: requireApiKey },
    async (request, reply) => {
      try {
        // Delete from PostgreSQL
        const [serversResult, queueResult, logsResult] = await Promise.all([
          db.delete(servers).returning(),
          db.delete(scanQueue).returning(),
          db.delete(taskLogs).returning(),
        ]);

        // Clear Redis queue data
        await safeRedisCommand(async (client) => {
          await client.del(REDIS_KEYS.QUEUE_PENDING);
          await client.del(REDIS_KEYS.QUEUE_PROCESSING);
          await client.del(REDIS_KEYS.QUEUE_DUPLICATES);
        });

        return reply.send({
          message: 'Server data purged successfully',
          deleted: {
            servers: serversResult.length,
            queueItems: queueResult.length,
            taskLogs: logsResult.length,
          },
        });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to purge server data', message: String(err) });
      }
    }
  );
}
