import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import {
  registerAgent,
  updateHeartbeat,
  listOnlineAgents,
  removeAgent,
} from '../services/agentService.js';
import { requireApiKey, requireTrustedNetwork } from '../middleware/auth.js';
import { scanQueue } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function agentRoutes(fastify: FastifyInstance) {
  const db = createDb();

  fastify.post<{ Body: { agentId: string; name?: string } }>(
    '/agents/register',
    { onRequest: requireTrustedNetwork },
    async (request, reply) => {
    const agentId = request.body?.agentId;
    if (!agentId || typeof agentId !== 'string') {
      return reply.code(400).send({ error: 'agentId is required' });
    }

    try {
      const result = await registerAgent(db, agentId, { name: request.body?.name });
      return reply.code(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid agentId')) {
        return reply.code(400).send({ error: message });
      }
      throw err;
    }
  });

  fastify.post<{ Body: { agentId: string; status?: string; currentQueueId?: string } }>(
    '/agents/heartbeat',
    { onRequest: requireTrustedNetwork },
    async (request, reply) => {
      const agentId = request.body?.agentId;
      if (!agentId || typeof agentId !== 'string') {
        return reply.code(400).send({ error: 'agentId is required' });
      }

      try {
        await updateHeartbeat(db, agentId, {
          status: request.body?.status,
          currentQueueId: request.body?.currentQueueId,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Invalid agentId')) {
          return reply.code(400).send({ error: message });
        }
        if (message.includes('not registered')) {
          return reply.code(404).send({ error: message });
        }
        throw err;
      }
    }
  );

  // List agents with current task address (protected - requires API key)
  fastify.get('/agents', { onRequest: requireApiKey }, async (_request, reply) => {
    const agents = await listOnlineAgents(db);
    
    // For each agent with a currentQueueId, look up the server address
    const agentsWithTask = await Promise.all(
      agents.map(async (agent) => {
        if (agent.currentQueueId) {
          try {
            const [queueEntry] = await db
              .select({ serverAddress: scanQueue.serverAddress })
              .from(scanQueue)
              .where(eq(scanQueue.id, agent.currentQueueId))
              .limit(1);
            
            return {
              ...agent,
              taskAddress: queueEntry?.serverAddress || null,
            };
          } catch {
            return { ...agent, taskAddress: null };
          }
        }
        return { ...agent, taskAddress: null };
      })
    );
    
    return reply.send(agentsWithTask);
  });

  // Remove an agent (protected - requires API key)
  fastify.delete<{ Params: { id: string } }>('/agents/:id', { onRequest: requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const success = await removeAgent(db, id);
    if (!success) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return reply.send({ ok: true });
  });
}
