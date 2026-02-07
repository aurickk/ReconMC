import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  claimFromQueue,
  completeScan,
  failScan,
  getQueueStatus,
  getQueueEntries,
} from '../services/redisQueueService.js';
import { z } from 'zod';

const claimSchema = z.object({
  agentId: z.string().min(1).max(100),
});

const completeSchema = z.object({
  result: z.unknown().optional(),
});

const failSchema = z.object({
  errorMessage: z.string().max(5000).default('Scan failed'),
});

const entriesQuerySchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

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
   * GET /api/queue/entries
   * Get queue entries with optional status filter (pending/processing/completed/failed/all)
   */
  fastify.get(
    '/queue/entries',
    async (request, reply) => {
      const parsed = entriesQuerySchema.safeParse((request as any).query);
      const { status, limit, offset } = parsed.success
        ? parsed.data
        : { status: 'all' as const, limit: 100, offset: 0 };

      try {
        const entries = await getQueueEntries(db, { status, limit, offset });
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
  fastify.post(
    '/queue/claim',
    async (request, reply) => {
      const parsed = claimSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'agentId is required', details: parsed.error.issues });
      }
      const { agentId } = parsed.data;

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
  fastify.post<{ Params: { id: string } }>(
    '/queue/:id/complete',
    async (request, reply) => {
      const parsed = completeSchema.safeParse(request.body);
      const result = parsed.success ? parsed.data.result : undefined;

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
  fastify.post<{ Params: { id: string } }>(
    '/queue/:id/fail',
    async (request, reply) => {
      const parsed = failSchema.safeParse(request.body);
      const errorMessage = parsed.success ? parsed.data.errorMessage : 'Scan failed';

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
