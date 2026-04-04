import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { eq, and, lt, asc } from 'drizzle-orm';
import { sessions } from '../db/schema.js';
import type { NewSession } from '../db/schema.js';
import { requireApiKey, requireTrustedNetwork } from '../middleware/auth.js';

/**
 * Agent-facing session routes (trusted-network auth only, no API key required).
 * These must be registered OUTSIDE the requireApiKey scope in server.ts
 * so that agents on the Docker network can access them.
 */
export async function sessionAgentRoutes(fastify: FastifyInstance) {
  const db = createDb();

  // POST /sessions/:id/invalidate - Agent reports invalid token (protected via requireTrustedNetwork)
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/invalidate',
    { onRequest: requireTrustedNetwork },
    async (request, reply) => {
      const { id } = request.params;

      // Delete the session immediately
      const deleted = await db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });

      // Idempotent: return 200 even if session was already deleted
      const wasDeleted = deleted.length > 0;

      // Try to find another available session for retry
      const [available] = await db.select().from(sessions)
        .where(and(eq(sessions.isActive, true), lt(sessions.currentUsage, sessions.maxConcurrent)))
        .orderBy(asc(sessions.currentUsage))
        .limit(1);

      return reply.send({
        deleted: wasDeleted,
        retryWith: available ? {
          id: available.id,
          accessToken: available.accessToken,
          username: available.username,
        } : null,
      });
    }
  );
}

export async function sessionRoutes(fastify: FastifyInstance) {
  const db = createDb();

  // GET /sessions - List all sessions (protected via requireApiKey)
  fastify.get('/sessions', { onRequest: requireApiKey }, async (_request, reply) => {
    const list = await db.select({
      id: sessions.id,
      username: sessions.username,
      uuid: sessions.uuid,
      currentUsage: sessions.currentUsage,
      maxConcurrent: sessions.maxConcurrent,
      isActive: sessions.isActive,
      lastUsedAt: sessions.lastUsedAt,
      createdAt: sessions.createdAt,
    }).from(sessions);
    return reply.send(list);
  });

  // POST /sessions - Add a single session (protected via requireApiKey)
  fastify.post<{
    Body: {
      accessToken: string;
      maxConcurrent?: number;
    };
  }>('/sessions', { onRequest: requireApiKey }, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.accessToken || typeof body.accessToken !== 'string') {
      return reply.code(400).send({ error: 'accessToken is required' });
    }

    const [row] = await db
      .insert(sessions)
      .values({
        username: null,
        accessToken: body.accessToken.trim(),
        uuid: null,
        maxConcurrent: body.maxConcurrent ?? 3,
      } as NewSession)
      .returning();
    return reply.code(201).send(row);
  });

  // POST /sessions/import - Bulk import session tokens (protected via requireApiKey)
  fastify.post<{
    Body: { tokens: string[] };
  }>('/sessions/import', { onRequest: requireApiKey }, async (request, reply) => {
    const tokens = request.body?.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return reply.code(400).send({ error: 'tokens array is required and must be non-empty' });
    }

    const sessionsToInsert: NewSession[] = [];

    for (const token of tokens) {
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        continue;
      }
      sessionsToInsert.push({
        username: null,
        accessToken: token.trim(),
        uuid: null,
        maxConcurrent: 3,
      } as NewSession);
    }

    let inserted: Array<typeof sessions.$inferSelect> = [];
    if (sessionsToInsert.length > 0) {
      inserted = await db.insert(sessions).values(sessionsToInsert).returning();
    }

    return reply.code(201).send({
      imported: inserted.length,
      sessions: inserted,
    });
  });

  // DELETE /sessions/:id - Remove a session (protected via requireApiKey)
  fastify.delete<{ Params: { id: string } }>('/sessions/:id', { onRequest: requireApiKey }, async (request, reply) => {
    const deleted = await db.delete(sessions).where(eq(sessions.id, request.params.id)).returning({ id: sessions.id });
    if (deleted.length === 0) return reply.code(404).send({ error: 'Session not found' });
    return reply.code(204).send();
  });

}
