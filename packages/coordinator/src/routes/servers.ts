import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  addToQueue,
  listServers,
  getServer,
  deleteServer,
  deleteScanHistory,
  getQueueStatus,
  type AddToQueueResult,
} from '../services/redisQueueService.js';
import { eq, or, and, sql, desc, asc } from 'drizzle-orm';
import { servers, scanQueue, taskLogs, agents } from '../db/schema.js';
import { safeRedisCommand, REDIS_KEYS } from '../db/redis.js';
import { requireApiKey } from '../middleware/auth.js';
import { listOnlineAgents } from '../services/agentService.js';
import { parseExcludeParam, buildSelectColumns, stripLatestResultFields } from '../utils/excludeFields.js';

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
    { onRequest: requireApiKey },
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
  fastify.get<{ Querystring: { limit?: string; offset?: string; exclude?: string } }>(
    '/servers',
    { onRequest: requireApiKey },
    async (request, reply) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
      const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;
      const { excludeColumns, excludeLatestResultKeys } = parseExcludeParam(request.query.exclude);

      try {
        const serverList = await listServers(db, { limit, offset, excludeColumns });
        const result = stripLatestResultFields(serverList, excludeLatestResultKeys);
        return reply.send(result);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to list servers', message: String(err) });
      }
    }
  );

  /**
   * GET /api/servers/search
   * Advanced server-side search with filtering support
   * Query params:
   *   - limit: number (default 100)
   *   - offset: number (default 0)
   *   - plugin: string (search plugins, use * for wildcard)
   *   - ip: string (search by IP address, supports partial match)
   *   - name: string (search by hostname, supports partial match)
   *   - players_min: number (minimum online players)
   *   - players_max: number (maximum online players)
   *   - location: string (country code or name)
   *   - version: string (server version, supports partial match)
   *   - motd: string (search MOTD content)
   *   - is_online: boolean (filter by online status)
   *   - account: string (bot account type: microsoft/cracked/*)
   *   - sort_by: string (field to sort by: last_scanned_at, first_seen_at, players)
   *   - command: string (search commands, use * for wildcard)
   *   - sort_order: string (asc or desc, default desc)
   */
  interface SearchQuerystring {
    limit?: string;
    offset?: string;
    plugin?: string;
    ip?: string;
    name?: string;
    players_min?: string;
    players_max?: string;
    location?: string;
    version?: string;
    motd?: string;
    is_online?: string;
    account?: string;
    sort_by?: string;
    sort_order?: string;
    exclude?: string;
    command?: string;
  }

  fastify.get<{ Querystring: SearchQuerystring }>(
    '/servers/search',
    { onRequest: requireApiKey },
    async (request, reply) => {
      const {
        limit = '100',
        offset = '0',
        plugin,
        ip,
        name,
        players_min,
        players_max,
        location,
        version,
        motd,
        is_online,
        account,
        sort_by = 'last_scanned_at',
        sort_order = 'desc',
        exclude,
        command,
      } = request.query;

      const limitNum = Math.min(parseInt(limit, 10) || 100, 500);
      const offsetNum = parseInt(offset, 10) || 0;
      const { excludeColumns, excludeLatestResultKeys } = parseExcludeParam(exclude);

      try {
        // Build WHERE conditions dynamically
        const conditions: any[] = [];

        // IP search (partial match using trigram)
        if (ip) {
          conditions.push(sql`${servers.resolvedIp} % ${ip}`);
        }

        // Name/hostname search (partial match using trigram)
        if (name) {
          conditions.push(
            or(
              sql`${servers.hostname} % ${name}`,
              sql`${servers.serverAddress} % ${name}`,
              sql`${servers.hostnames}::jsonb ? ${name}`
            )
          );
        }

        // Online status filter
        if (is_online !== undefined) {
          const isOnlineBool = is_online.toLowerCase() === 'true';
          conditions.push(sql`(${servers.latestResult}->>'online')::boolean = ${isOnlineBool}`);
        }

        // Player count range
        if (players_min !== undefined || players_max !== undefined) {
          const minPlayers = players_min ? parseInt(players_min, 10) : 0;
          if (players_max !== undefined) {
            const maxPlayers = parseInt(players_max, 10);
            conditions.push(
              and(
                sql`COALESCE((${servers.latestResult}->>'playersOnline')::int, 0) >= ${minPlayers}`,
                sql`COALESCE((${servers.latestResult}->>'playersOnline')::int, 0) <= ${maxPlayers}`
              )
            );
          } else {
            conditions.push(sql`COALESCE((${servers.latestResult}->>'playersOnline')::int, 0) >= ${minPlayers}`);
          }
        }

        // Version search (partial match)
        if (version) {
          conditions.push(sql`${servers.latestResult}->>'version' ILIKE ${`%${version}%`}`);
        }

        // MOTD search (partial match)
        if (motd) {
          conditions.push(sql`${servers.latestResult}->>'motd' ILIKE ${`%${motd}%`}`);
        }

        // Location search (country code or name)
        if (location) {
          conditions.push(
            or(
              sql`${servers.latestResult}->'geo'->>'countryCode' ILIKE ${location}`,
              sql`${servers.latestResult}->'geo'->>'country' ILIKE ${`%${location}%`}`
            )
          );
        }

        // Plugin search (check if plugin exists in the plugins array)
        if (plugin) {
          if (plugin === '*') {
            // Wildcard - has any plugins
            conditions.push(sql`jsonb_array_length(COALESCE(${servers.latestResult}->'plugins', '[]'::jsonb)) > 0`);
          } else {
            // Specific plugin name
            conditions.push(
              sql`EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(${servers.latestResult}->'plugins', '[]'::jsonb)) AS p
                WHERE p->>'name' ILIKE ${`%${plugin}%`}
              )`
            );
          }
        }

        // Command search (check if command exists in the commands array)
        // IMPORTANT: commands are flat strings ["tpa", "home"], NOT objects like plugins
        // Use jsonb_array_elements_text (not jsonb_array_elements with ->>'name')
        if (command) {
          if (command === '*') {
            // Wildcard - has any commands
            conditions.push(sql`jsonb_array_length(COALESCE(${servers.latestResult}->'commands', '[]'::jsonb)) > 0`);
          } else {
            // Specific command name (case-insensitive partial match)
            conditions.push(
              sql`EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(COALESCE(${servers.latestResult}->'commands', '[]'::jsonb)) AS c
                WHERE c ILIKE ${`%${command}%`}
              )`
            );
          }
        }

        // Account type filter
        if (account && account !== '*') {
          conditions.push(sql`${servers.latestResult}->>'accountType' = ${account}`);
        }

        // Build the base query (conditionally exclude columns)
        const columns = buildSelectColumns(excludeColumns);
        let query = columns ? db.select(columns).from(servers) : db.select().from(servers);

        // Apply WHERE clause if there are conditions
        if (conditions.length > 0) {
          const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
          query = query.where(whereClause) as typeof query;
        }

        // Get total count for pagination (using a separate count query for efficiency)
        const countQuery = db
          .select({ count: sql<number>`count(*)::int` })
          .from(servers);

        if (conditions.length > 0) {
          const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
          (countQuery as any).where(whereClause);
        }

        // Apply sorting
        const sortOrder = sort_order.toLowerCase() === 'asc' ? asc : desc;
        let orderByExpr: any;

        switch (sort_by) {
          case 'first_seen_at':
            orderByExpr = sortOrder(servers.firstSeenAt);
            break;
          case 'players':
            orderByExpr = sql`COALESCE((${servers.latestResult}->>'playersOnline')::int, 0) ${sql.raw(sort_order.toUpperCase())}`;
            break;
          case 'last_scanned_at':
          default:
            orderByExpr = sortOrder(servers.lastScannedAt);
            break;
        }

        // Execute queries
        const [serversResult, countResult] = await Promise.all([
          (query as any)
            .orderBy(orderByExpr)
            .limit(limitNum)
            .offset(offsetNum),
          countQuery
        ]);

        const totalCount = countResult[0]?.count ?? 0;

        return reply.send({
          servers: stripLatestResultFields(serversResult, excludeLatestResultKeys),
          totalCount,
          limit: limitNum,
          offset: offsetNum,
          hasMore: offsetNum + limitNum < totalCount,
        });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to search servers', message: String(err) });
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
    { onRequest: requireApiKey },
    async (request, reply) => {
      try {
        const address = request.params.address;
        // Parse address to handle both "host:port" and "host" formats
        const [hostPart, portPart] = address.split(':');
        const host = hostPart ?? address;
        const port = portPart ? parseInt(portPart, 10) : 25565;
        const isIp = /^[\d.]+$|^\[?[0-9a-fA-F:]+\]?$/.test(host);

        // Match by hostname + port (primary), resolvedIp + port, or hostnames array
        const [server] = await db
          .select()
          .from(servers)
          .where(
            or(
              // Direct hostname match
              and(eq(servers.hostname, host), eq(servers.port, port)),
              // IP match (for raw IP inputs or reverse lookups)
              and(eq(servers.resolvedIp, host), eq(servers.port, port)),
              // Hostname in hostnames array + port match
              sql`(${servers.hostnames})::jsonb ? ${host} AND ${servers.port} = ${port}`
            )
          )
          .limit(1);

        if (!server) {
          // If a hostname was given, try resolving to IP as fallback
          if (!isIp) {
            const { resolveServerIp } = await import('../services/ipResolver.js');
            try {
              const resolvedIp = await resolveServerIp(host);
              const [serverByIp] = await db
                .select()
                .from(servers)
                .where(and(eq(servers.resolvedIp, resolvedIp), eq(servers.port, port)))
                .limit(1);
              if (serverByIp) return reply.send(serverByIp);
            } catch {
              // Resolution failed, return 404
            }
          }
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
    { onRequest: requireApiKey },
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

  fastify.get('/dashboard/stats', { onRequest: requireApiKey }, async (_request, reply) => {
    try {
      const [totalServersResult, queueStatus, onlineAgentsList, recentServersResult] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(servers),
        getQueueStatus(db),
        listOnlineAgents(db),
        db
          .select({
            id: servers.id,
            serverAddress: servers.serverAddress,
            hostname: servers.hostname,
            latestResult: servers.latestResult,
            lastScannedAt: servers.lastScannedAt,
            scanCount: servers.scanCount,
          })
          .from(servers)
          .orderBy(desc(servers.lastScannedAt))
          .limit(10),
      ]);

      const recentServers = recentServersResult.map((server) => {
        const result = server.latestResult as { online?: boolean; accountType?: string } | null;
        const isOnline = result?.online ?? false;
        const accountType = result?.accountType;
        
        let status: 'online' | 'offline' | 'pending' = 'pending';
        if (server.lastScannedAt) {
          status = isOnline ? 'online' : 'offline';
        }
        
        let mode: 'online' | 'cracked' | 'unknown' = 'unknown';
        if (accountType === 'microsoft') {
          mode = 'online';
        } else if (accountType === 'cracked') {
          mode = 'cracked';
        }

        return {
          id: server.id,
          address: server.hostname || server.serverAddress,
          status,
          mode,
          lastScanned: server.lastScannedAt,
          scanCount: server.scanCount,
        };
      });

      return reply.send({
        totalServers: totalServersResult[0]?.count ?? 0,
        pendingScans: queueStatus.pending,
        processingScans: queueStatus.processing,
        onlineAgents: onlineAgentsList.length,
        recentServers,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to get dashboard stats', message: String(err) });
    }
  });
}
