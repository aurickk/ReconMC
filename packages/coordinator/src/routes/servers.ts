import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  addToQueue,
  listServers,
  getServer,
  deleteServer,
  type AddToQueueResult,
} from '../services/redisQueueService.js';
import { eq, or, sql } from 'drizzle-orm';
import { servers } from '../db/schema.js';
import { z } from 'zod';

const addServersSchema = z.object({
  servers: z.array(z.string().min(1).max(255)).min(1).max(10000),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

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
      const parsed = addServersSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
      }

      try {
        const result = await addToQueue(db, { servers: parsed.data.servers });
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
      const params = paginationSchema.safeParse(request.query);
      const limit = params.success ? params.data.limit : 100;
      const offset = params.success ? params.data.offset : 0;

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
   * Get server by address (hostname:port or hostname)
   * This is useful for Discord bot to find scan results without pagination
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

        // Try exact match first, then match by hostname + port
        const [server] = await db
          .select()
          .from(servers)
          .where(
            or(
              eq(servers.serverAddress, address),
              sql`${servers.hostname} = ${host} AND ${servers.port} = ${port}`
            )
          )
          .limit(1);

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
   * GET /api/servers/:id
   * Get server with full scan history
   */
  fastify.get<{ Params: { id: string } }>(
    '/servers/:id',
    async (request, reply) => {
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
   * Delete a server record
   */
  fastify.delete<{ Params: { id: string } }>(
    '/servers/:id',
    async (request, reply) => {
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
}
