import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  claimFromQueue,
  completeScan,
  failScan,
  getQueueStatus,
  getQueueEntries,
} from '../services/redisQueueService.js';
import { sql, eq, and, lt } from 'drizzle-orm';
import { proxies, accounts, agents, scanQueue } from '../db/schema.js';

export async function queueRoutes(fastify: FastifyInstance) {
  const db = createDb();

  /**
   * GET /api/queue
   * Get queue status (pending/processing counts)
   */
  fastify.get('/queue', async (_request, reply) => {
    try {
      const status = await getQueueStatus(db);
      return reply.send(status);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to get queue status', message: String(err) });
    }
  });

  /**
   * GET /api/queue/diagnostics
   * Get diagnostic information about why agents might be idle
   * This helps identify resource allocation issues
   */
  fastify.get('/queue/diagnostics', async (_request, reply) => {
    try {
      // Check proxy availability
      const proxyStats = await db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) FILTER (WHERE is_active = true)::int`,
          available: sql<number>`count(*) FILTER (WHERE is_active = true AND current_usage < max_concurrent)::int`,
          totalCapacity: sql<number>`COALESCE(SUM(max_concurrent) FILTER (WHERE is_active = true), 0)::int`,
          usedCapacity: sql<number>`COALESCE(SUM(current_usage) FILTER (WHERE is_active = true), 0)::int`,
        })
        .from(proxies);

      // Check account availability
      const accountStats = await db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) FILTER (WHERE is_active = true)::int`,
          valid: sql<number>`count(*) FILTER (WHERE is_active = true AND is_valid = true)::int`,
          available: sql<number>`count(*) FILTER (WHERE is_active = true AND is_valid = true AND current_usage < max_concurrent)::int`,
          totalCapacity: sql<number>`COALESCE(SUM(max_concurrent) FILTER (WHERE is_active = true AND is_valid = true), 0)::int`,
          usedCapacity: sql<number>`COALESCE(SUM(current_usage) FILTER (WHERE is_active = true AND is_valid = true), 0)::int`,
        })
        .from(accounts);

      // Check agent status
      const agentStats = await db
        .select({
          total: sql<number>`count(*)::int`,
          idle: sql<number>`count(*) FILTER (WHERE status = 'idle')::int`,
          busy: sql<number>`count(*) FILTER (WHERE status = 'busy')::int`,
          stale: sql<number>`count(*) FILTER (WHERE last_heartbeat < NOW() - INTERVAL '70 seconds')::int`,
        })
        .from(agents);

      // Check queue status
      const queueStats = await getQueueStatus(db);

      // Check for stuck processing items
      const stuckItems = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scanQueue)
        .where(
          and(
            eq(scanQueue.status, 'processing'),
            sql`${scanQueue.startedAt} < NOW() - INTERVAL '5 minutes'`
          )
        );

      // Determine why agents might be idle
      const issues: string[] = [];

      if (proxyStats[0]?.total === 0) {
        issues.push('No proxies configured - add proxies to enable scanning');
      } else if (proxyStats[0]?.active === 0) {
        issues.push('All proxies are inactive - activate at least one proxy');
      } else if (proxyStats[0]?.available === 0) {
        issues.push(`All proxies at capacity (${proxyStats[0]?.usedCapacity}/${proxyStats[0]?.totalCapacity} slots used) - add more proxies or increase max_concurrent`);
      }

      if (accountStats[0]?.total === 0) {
        issues.push('No accounts configured - add accounts to enable scanning');
      } else if (accountStats[0]?.valid === 0) {
        issues.push('No valid accounts - all accounts are marked as invalid');
      } else if (accountStats[0]?.available === 0) {
        issues.push(`All accounts at capacity (${accountStats[0]?.usedCapacity}/${accountStats[0]?.totalCapacity} slots used) - add more accounts or increase max_concurrent`);
      }

      if (agentStats[0]?.total === 0) {
        issues.push('No agents registered - start the agent service');
      } else if (agentStats[0]?.idle === 0 && queueStats.pending > 0) {
        issues.push(`All agents are busy (${agentStats[0]?.busy} busy) - scale up agent replicas`);
      }

      if (stuckItems[0]?.count > 0) {
        issues.push(`${stuckItems[0]?.count} stuck processing items - run recoverStuckTasks or wait for automatic recovery`);
      }

      return reply.send({
        proxies: proxyStats[0],
        accounts: accountStats[0],
        agents: agentStats[0],
        queue: queueStats,
        stuckItems: stuckItems[0]?.count ?? 0,
        issues,
        canProcess: issues.length === 0,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to get diagnostics', message: String(err) });
    }
  });

  /**
   * GET /api/queue/entries
   * Get queue entries with optional status filter (pending/processing/completed/failed/all)
   */
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/queue/entries',
    async (request, reply) => {
      const { status = 'all', limit = '100', offset = '0' } = request.query;
      const validStatuses = ['pending', 'processing', 'completed', 'failed', 'all'];

      if (!validStatuses.includes(status)) {
        return reply.code(400).send({ error: 'Invalid status filter' });
      }

      try {
        const entries = await getQueueEntries(db, {
          status: status as 'pending' | 'processing' | 'completed' | 'failed' | 'all',
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
        });
        return reply.send(entries);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to get queue entries', message: String(err) });
      }
    }
  );

  /**
   * POST /api/queue/claim
   * Agent claims next server from queue
   * Replaces /api/tasks/claim
   */
  fastify.post<{ Body: { agentId: string } }>(
    '/queue/claim',
    async (request, reply) => {
      const { agentId } = request.body ?? {};
      if (!agentId || typeof agentId !== 'string') {
        return reply.code(400).send({ error: 'agentId is required' });
      }

      try {
        const claimed = await claimFromQueue(db, agentId);
        if (!claimed) {
          return reply.code(204).send();
        }
        return reply.send(claimed);
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to claim queue item', message: String(err) });
      }
    }
  );

  /**
   * POST /api/queue/:id/complete
   * Complete a scan, update history, remove from queue
   * Replaces /api/tasks/:id/complete
   */
  fastify.post<{ Params: { id: string }; Body: { result?: unknown } }>(
    '/queue/:id/complete',
    async (request, reply) => {
      const { result } = request.body ?? {};

      try {
        await completeScan(db, request.params.id, result);
        return reply.send({ message: 'Scan completed successfully' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to complete scan', message: String(err) });
      }
    }
  );

  /**
   * POST /api/queue/:id/fail
   * Fail a scan, remove from queue with cleanup
   * Replaces /api/tasks/:id/fail
   */
  fastify.post<{ Params: { id: string }; Body: { errorMessage?: string } }>(
    '/queue/:id/fail',
    async (request, reply) => {
      const { errorMessage = 'Scan failed' } = request.body ?? {};

      try {
        await failScan(db, request.params.id, errorMessage);
        return reply.send({ message: 'Scan failed and removed from queue' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to fail scan', message: String(err) });
      }
    }
  );
}
