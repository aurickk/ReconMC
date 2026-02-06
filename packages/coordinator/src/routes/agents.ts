import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { eq, sql } from 'drizzle-orm';
import { agents } from '../db/schema.js';
import type { NewAgent } from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';

const HEARTBEAT_TIMEOUT_MS = 60_000;

// Remove offline agents immediately - agents are ephemeral
async function removeOfflineAgents(db: ReturnType<typeof createDb>): Promise<void> {
  const threshold = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
  await db
    .delete(agents)
    .where(
      sql`${agents.lastHeartbeat} < ${threshold}`
    );
}

/**
 * Validate agent ID format (prevent injection attacks)
 * Only allows alphanumeric characters, dashes, and underscores
 */
function isValidAgentId(agentId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(agentId) && agentId.length >= 1 && agentId.length <= 100;
}

/**
 * Extract agent number from agent ID (e.g., "agent-1" → 1, "agent-2" → 2)
 * Falls back to counting current agents if ID doesn't match expected format
 */
function getAgentNumberFromId(agentId: string, db: ReturnType<typeof createDb>): number | Promise<number> {
  // Agent IDs from Docker are like "agent-1", "agent-2", etc.
  const match = agentId.match(/^agent-(\d+)$/);
  if (match) {
    return parseInt(match[1]!, 10);
  }

  // Fallback: use sequential counter for old-style IDs (hash-based)
  return (async () => {
    await removeOfflineAgents(db);
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents);
    return (result[0]?.count ?? 0) + 1;
  })();
}

export async function agentRoutes(fastify: FastifyInstance) {
  const db = createDb();

  // Agent registration (public - agents are in same Docker network)
  fastify.post<{ Body: { agentId: string } }>('/agents/register', async (request, reply) => {
    const agentId = request.body?.agentId;
    if (!agentId || typeof agentId !== 'string') {
      return reply.code(400).send({ error: 'agentId is required' });
    }

    // Validate agent ID format
    if (!isValidAgentId(agentId)) {
      return reply.code(400).send({ error: 'Invalid agentId format' });
    }

    // Always derive agent name from ID (e.g., "agent-1" → "Agent 1")
    const agentNumber = await getAgentNumberFromId(agentId, db);
    const agentName = `Agent ${agentNumber}`;

    await db
      .insert(agents)
      .values({
        id: agentId,
        name: agentName,
        status: 'idle',
      } as NewAgent)
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: agentName,
          status: 'idle',
          lastHeartbeat: new Date(),
          currentTaskId: null,
        },
      });

    return reply.code(200).send({ ok: true, agentId, agentName });
  });

  // Agent heartbeat (public - agents are in same Docker network)
  fastify.post<{ Body: { agentId: string; status?: string; currentTaskId?: string } }>(
    '/agents/heartbeat',
    async (request, reply) => {
      const agentId = request.body?.agentId;
      if (!agentId || typeof agentId !== 'string') {
        return reply.code(400).send({ error: 'agentId is required' });
      }

      // Validate agent ID format
      if (!isValidAgentId(agentId)) {
        return reply.code(400).send({ error: 'Invalid agentId format' });
      }

      const [existing] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not registered' });
      }

      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
          ...(request.body?.status && { status: request.body.status }),
          ...(request.body?.currentTaskId !== undefined && { currentTaskId: request.body.currentTaskId }),
        })
        .where(eq(agents.id, agentId));
      return reply.code(200).send({ ok: true });
    }
  );

  // List agents (protected - requires API key for external users to view status)
  fastify.get('/agents', { onRequest: requireApiKey }, async (_request, reply) => {
    // Always clean up offline agents first - agents are ephemeral
    await removeOfflineAgents(db);

    const list = await db.select().from(agents);
    const now = Date.now();
    const withStatus = list.map((a) => ({
      ...a,
      offline: now - new Date(a.lastHeartbeat).getTime() > HEARTBEAT_TIMEOUT_MS,
    }));
    return reply.send(withStatus);
  });
}
