import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  claimFromQueue,
  completeScan,
  failScan,
  getQueueStatus,
} from '../services/scanQueueManager.js';

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
