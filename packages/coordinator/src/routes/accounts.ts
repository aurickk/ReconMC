import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { eq, and, lt } from 'drizzle-orm';
import { accounts, proxies } from '../db/schema.js';
import type { NewAccount } from '../db/schema.js';
import { validateAccount } from '../services/account-validator.js';
import type { SocksProxyConfig } from '../services/proxied-fetch.js';
import { requireApiKey } from '../middleware/auth.js';

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

export async function accountRoutes(fastify: FastifyInstance) {
  const db = createDb();

  fastify.get('/accounts', { onRequest: requireApiKey }, async (_request, reply) => {
    const list = await db.select({
      id: accounts.id,
      type: accounts.type,
      username: accounts.username,
      currentUsage: accounts.currentUsage,
      maxConcurrent: accounts.maxConcurrent,
      isActive: accounts.isActive,
      isValid: accounts.isValid,
      lastValidatedAt: accounts.lastValidatedAt,
      lastValidationError: accounts.lastValidationError,
      lastUsedAt: accounts.lastUsedAt,
      createdAt: accounts.createdAt,
    }).from(accounts);
    return reply.send(list);
  });

  // Export accounts (returns all account data including tokens for re-importing) (protected)
  fastify.get('/accounts/export', { onRequest: requireApiKey }, async (_request, reply) => {
    const list = await db.select({
      type: accounts.type,
      username: accounts.username,
      accessToken: accounts.accessToken,
      refreshToken: accounts.refreshToken,
      maxConcurrent: accounts.maxConcurrent,
    }).from(accounts).where(eq(accounts.isActive, true));
    return reply.send(list);
  });

  fastify.post<{
    Body: {
      type: string;
      username?: string;
      accessToken?: string;
      refreshToken?: string;
      maxConcurrent?: number;
    };
  }>('/accounts', { onRequest: requireApiKey }, async (request, reply) => {
    const body = request.body ?? {};
    if (body.type !== 'microsoft' && body.type !== 'cracked') {
      return reply.code(400).send({ error: 'type must be microsoft or cracked' });
    }

    // Pick a proxy from the pool for Microsoft API calls (avoids rate limiting)
    const proxy = body.type === 'microsoft' ? await pickProxyFromPool(db) : undefined;

    // Validate account credentials (with refresh token for Microsoft accounts)
    const validation = await validateAccount(
      body.type,
      body.accessToken ?? null,
      body.username ?? null,
      body.refreshToken ?? null,
      proxy
    );

    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Account validation failed',
        details: validation.error,
      });
    }

    const [row] = await db
      .insert(accounts)
      .values({
        type: body.type,
        username: validation.username ?? null,
        // Use refreshed token if validation performed a refresh
        accessToken: validation.newAccessToken ?? body.accessToken ?? null,
        refreshToken: validation.newRefreshToken ?? body.refreshToken ?? null,
        maxConcurrent: body.maxConcurrent ?? 3,
        isValid: true,
        lastValidatedAt: new Date(),
      } as NewAccount)
      .returning();
    return reply.code(201).send(row);
  });

  fastify.put<{
    Params: { id: string };
    Body: Partial<{ username: string; accessToken: string; refreshToken: string; isActive: boolean; maxConcurrent: number }>;
  }>('/accounts/:id', { onRequest: requireApiKey }, async (request, reply) => {
    const [existing] = await db.select().from(accounts).where(eq(accounts.id, request.params.id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Account not found' });
    const body = request.body ?? {};

    // If updating access token, re-validate the account
    if (body.accessToken !== undefined && existing.type === 'microsoft') {
      const proxy = await pickProxyFromPool(db);
      const validation = await validateAccount(
        existing.type,
        body.accessToken,
        body.username ?? existing.username ?? null,
        body.refreshToken ?? existing.refreshToken ?? null,
        proxy
      );

      const [updated] = await db
        .update(accounts)
        .set({
          ...(body.username !== undefined && { username: body.username }),
          accessToken: validation.newAccessToken ?? body.accessToken,
          refreshToken: validation.newRefreshToken ?? body.refreshToken ?? existing.refreshToken,
          ...(body.isActive !== undefined && { isActive: body.isActive }),
          ...(body.maxConcurrent !== undefined && { maxConcurrent: body.maxConcurrent }),
          isValid: validation.valid,
          lastValidatedAt: validation.valid ? new Date() : null,
          lastValidationError: validation.error ?? null,
        })
        .where(eq(accounts.id, request.params.id))
        .returning();
      return reply.send(updated);
    }

    const [updated] = await db
      .update(accounts)
      .set({
        ...(body.username !== undefined && { username: body.username }),
        ...(body.accessToken !== undefined && { accessToken: body.accessToken }),
        ...(body.refreshToken !== undefined && { refreshToken: body.refreshToken }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.maxConcurrent !== undefined && { maxConcurrent: body.maxConcurrent }),
      })
      .where(eq(accounts.id, request.params.id))
      .returning();
    return reply.send(updated);
  });

  // Re-validate an existing account (protected)
  fastify.post<{ Params: { id: string } }>(
    '/accounts/:id/validate',
    { onRequest: requireApiKey },
    async (request, reply) => {
      const [existing] = await db.select().from(accounts).where(eq(accounts.id, request.params.id)).limit(1);
      if (!existing) return reply.code(404).send({ error: 'Account not found' });

      fastify.log.info(`[Accounts] Validating account ${request.params.id} (type: ${existing.type})`);

      const proxy = existing.type === 'microsoft' ? await pickProxyFromPool(db) : undefined;
      const validation = await validateAccount(
        existing.type,
        existing.accessToken,
        existing.username,
        existing.refreshToken,
        proxy
      );

      if (validation.valid) {
        fastify.log.info(`[Accounts] Account ${request.params.id} validated successfully: ${validation.username}${validation.refreshed ? ' (tokens refreshed)' : ''}`);
      } else {
        fastify.log.warn(`[Accounts] Account ${request.params.id} validation failed: ${validation.error}`);
      }

      const [updated] = await db
        .update(accounts)
        .set({
          isValid: validation.valid,
          lastValidatedAt: new Date(),
          lastValidationError: validation.error ?? null,
          ...(validation.username && { username: validation.username }),
          // Store refreshed tokens if validation performed a refresh
          ...(validation.newAccessToken && { accessToken: validation.newAccessToken }),
          ...(validation.newRefreshToken && { refreshToken: validation.newRefreshToken }),
        })
        .where(eq(accounts.id, request.params.id))
        .returning();

      return reply.send({
        valid: validation.valid,
        username: validation.username,
        error: validation.error,
        refreshed: validation.refreshed,
        account: updated,
      });
    }
  );

  // Update account tokens (called by agents after refreshing)
  // Public - agents are in same Docker network and need to update tokens after Microsoft auth refresh
  fastify.put<{
    Params: { id: string };
    Body: { accessToken: string; refreshToken?: string };
  }>('/accounts/:id/tokens', async (request, reply) => {
    const [existing] = await db.select().from(accounts).where(eq(accounts.id, request.params.id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Account not found' });

    const { accessToken, refreshToken } = request.body ?? {};
    if (!accessToken || typeof accessToken !== 'string') {
      return reply.code(400).send({ error: 'accessToken is required' });
    }

    const updated = await db
      .update(accounts)
      .set({
        accessToken,
        ...(refreshToken !== undefined && { refreshToken }),
        lastValidatedAt: new Date(),
        isValid: true,
        lastValidationError: null,
      })
      .where(eq(accounts.id, request.params.id))
      .returning({
        id: accounts.id,
        type: accounts.type,
        username: accounts.username,
        isValid: accounts.isValid,
      });

    if (updated.length === 0) return reply.code(404).send({ error: 'Failed to update account' });

    return reply.send({ ok: true, account: updated[0]! });
  });

  fastify.delete<{ Params: { id: string } }>('/accounts/:id', { onRequest: requireApiKey }, async (request, reply) => {
    const deleted = await db.delete(accounts).where(eq(accounts.id, request.params.id)).returning({ id: accounts.id });
    if (deleted.length === 0) return reply.code(404).send({ error: 'Account not found' });
    return reply.code(204).send();
  });

  fastify.post<{ Body: { accounts: Array<{ type: string; username?: string; accessToken?: string; refreshToken?: string }> } }>(
    '/accounts/import',
    { onRequest: requireApiKey },
    async (request, reply) => {
      const list = request.body?.accounts;
      if (!Array.isArray(list) || list.length === 0) {
        return reply.code(400).send({ error: 'accounts array is required' });
      }

      // Validate each account and build results
      const accountsToInsert: NewAccount[] = [];
      const validationResults: Array<{ index: number; valid: boolean; username?: string; error?: string }> = [];

      // Pick a proxy once for the batch (avoids hitting pool for every account)
      const batchProxy = await pickProxyFromPool(db);

      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const type = a.type === 'cracked' ? 'cracked' : 'microsoft';

        const validation = await validateAccount(
          type,
          a.accessToken ?? null,
          a.username ?? null,
          a.refreshToken ?? null,
          type === 'microsoft' ? batchProxy : undefined
        );

        validationResults.push({
          index: i,
          valid: validation.valid,
          username: validation.username,
          error: validation.error,
        });

        accountsToInsert.push({
          type,
          username: validation.username ?? null,
          accessToken: validation.newAccessToken ?? a.accessToken ?? null,
          refreshToken: validation.newRefreshToken ?? a.refreshToken ?? null,
          maxConcurrent: 3,
          isValid: validation.valid,
          lastValidatedAt: validation.valid ? new Date() : null,
          lastValidationError: validation.error ?? null,
        } as NewAccount);
      }

      const inserted = await db.insert(accounts).values(accountsToInsert).returning();

      const successful = validationResults.filter(r => r.valid).length;
      const failed = validationResults.filter(r => !r.valid).length;

      return reply.code(201).send({
        imported: inserted.length,
        successful,
        failed,
        accounts: inserted,
      });
    }
  );
}
