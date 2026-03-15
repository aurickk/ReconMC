import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { eq, and, lt, asc } from 'drizzle-orm';
import { sessions, proxies } from '../db/schema.js';
import type { NewSession } from '../db/schema.js';
import { validateSessionToken } from '../services/session-validator.js';
import type { SocksProxyConfig } from '../services/proxied-fetch.js';
import { requireApiKey, requireTrustedNetwork } from '../middleware/auth.js';

/**
 * Pick a random available proxy from the pool for API calls.
 * Returns undefined if no proxies are available (falls back to direct).
 */
async function pickProxyFromPool(db: ReturnType<typeof createDb>): Promise<SocksProxyConfig | undefined> {
  try {
    const [proxy] = await db
      .select()
      .from(proxies)
      .where(and(eq(proxies.isActive, true), lt(proxies.currentUsage, proxies.maxConcurrent)))
      .limit(1);

    if (!proxy) return undefined;

    return {
      host: proxy.host,
      port: proxy.port,
      type: (proxy.protocol === 'socks4' ? 'socks4' : 'socks5') as 'socks4' | 'socks5',
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  } catch {
    return undefined; // Fall back to direct connection
  }
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

    // Pick a proxy from the pool for Minecraft API calls
    const proxy = await pickProxyFromPool(db);

    const validation = await validateSessionToken(body.accessToken.trim(), proxy);

    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Session validation failed',
        details: validation.error,
      });
    }

    const [row] = await db
      .insert(sessions)
      .values({
        username: validation.username ?? null,
        accessToken: body.accessToken.trim(),
        uuid: validation.uuid ?? null,
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

    // Pick a proxy once for the batch
    const batchProxy = await pickProxyFromPool(db);

    const sessionsToInsert: NewSession[] = [];
    const errors: Array<{ index: number; token: string; error: string }> = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        continue; // Skip empty strings
      }

      const trimmedToken = token.trim();

      const validation = await validateSessionToken(trimmedToken, batchProxy);

      if (validation.valid) {
        sessionsToInsert.push({
          username: validation.username ?? null,
          accessToken: trimmedToken,
          uuid: validation.uuid ?? null,
          maxConcurrent: 3,
        } as NewSession);
      } else {
        errors.push({
          index: i,
          token: trimmedToken.substring(0, 8) + '...',
          error: validation.error ?? 'Invalid token',
        });

        // On 429 rate limit, back off 5 seconds before next attempt
        if (validation.error?.includes('Rate limited')) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
      }

      // Throttle: 1 second between validation calls to avoid Minecraft API rate limits
      if (i < tokens.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Batch insert all valid sessions
    let inserted: Array<typeof sessions.$inferSelect> = [];
    if (sessionsToInsert.length > 0) {
      inserted = await db.insert(sessions).values(sessionsToInsert).returning();
    }

    return reply.code(201).send({
      imported: inserted.length,
      rejected: errors.length,
      sessions: inserted,
      errors,
    });
  });

  // DELETE /sessions/:id - Remove a session (protected via requireApiKey)
  fastify.delete<{ Params: { id: string } }>('/sessions/:id', { onRequest: requireApiKey }, async (request, reply) => {
    const deleted = await db.delete(sessions).where(eq(sessions.id, request.params.id)).returning({ id: sessions.id });
    if (deleted.length === 0) return reply.code(404).send({ error: 'Session not found' });
    return reply.code(204).send();
  });

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
          sessionId: available.id,
          accessToken: available.accessToken,
          username: available.username,
        } : null,
      });
    }
  );
}
