import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { createBatch, cancelBatch, deleteBatch } from '../services/taskManager.js';
import { eq, and, or } from 'drizzle-orm';
import { batches, tasks } from '../db/schema.js';

export async function batchRoutes(fastify: FastifyInstance) {
  const db = createDb();

  fastify.post<{ Body: { servers: string[]; name?: string } }>('/batches', async (request, reply) => {
    const { servers, name } = request.body ?? {};
    if (!Array.isArray(servers) || servers.length === 0) {
      return reply.code(400).send({ error: 'servers array is required and must not be empty' });
    }
    try {
      const result = await createBatch(db, { servers, name });
      return reply.code(201).send(result);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to create batch', message: String(err) });
    }
  });

  fastify.get('/batches', async (_request, reply) => {
    const list = await db.select().from(batches).orderBy(batches.createdAt);
    return reply.send(list);
  });

  fastify.get<{ Params: { id: string } }>('/batches/:id', async (request, reply) => {
    const [batch] = await db.select().from(batches).where(eq(batches.id, request.params.id)).limit(1);
    if (!batch) return reply.code(404).send({ error: 'Batch not found' });
    return reply.send(batch);
  });

  fastify.get<{ Params: { id: string } }>('/batches/:id/results', async (request, reply) => {
    const [batch] = await db.select().from(batches).where(eq(batches.id, request.params.id)).limit(1);
    if (!batch) return reply.code(404).send({ error: 'Batch not found' });
    const taskList = await db.select().from(tasks).where(eq(tasks.batchId, request.params.id));
    return reply.send({ batch, tasks: taskList });
  });

  /**
   * Cancel a batch - stops processing and marks pending tasks as cancelled
   */
  fastify.post<{ Params: { id: string } }>('/batches/:id/cancel', async (request, reply) => {
    const [batch] = await db.select().from(batches).where(eq(batches.id, request.params.id)).limit(1);
    if (!batch) return reply.code(404).send({ error: 'Batch not found' });

    // Only allow cancelling pending or processing batches
    if (batch.status === 'completed' || batch.status === 'cancelled') {
      return reply.code(400).send({ error: `Cannot cancel batch with status: ${batch.status}` });
    }

    try {
      const result = await cancelBatch(db, request.params.id);
      return reply.send({
        message: 'Batch cancelled successfully',
        cancelledCount: result.cancelledCount,
        releasedCount: result.releasedCount,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to cancel batch', message: String(err) });
    }
  });

  /**
   * Delete a batch and all its tasks
   */
  fastify.delete<{ Params: { id: string } }>('/batches/:id', async (request, reply) => {
    const [batch] = await db.select().from(batches).where(eq(batches.id, request.params.id)).limit(1);
    if (!batch) return reply.code(404).send({ error: 'Batch not found' });

    try {
      const result = await deleteBatch(db, request.params.id);
      return reply.send({
        message: 'Batch deleted successfully',
        deletedCount: result.deletedCount,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to delete batch', message: String(err) });
    }
  });
}
