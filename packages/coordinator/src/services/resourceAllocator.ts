import { and, eq, lt, asc, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { proxies, sessions, scanQueue } from '../db/schema.js';
import type { Proxy, Session } from '../db/schema.js';
import { logger } from '../logger.js';

export interface AllocatedResources {
  proxy: Proxy;
  session: Session;
}

// Use any for transaction type - drizzle's type extraction is too complex
export type Transaction = Db extends { transaction: (fn: (tx: infer T) => Promise<any>) => Promise<any> } ? T : never;

export async function allocateResourcesTx(tx: Transaction): Promise<AllocatedResources | null> {
  const availableProxy = await tx
    .select()
    .from(proxies)
    .where(and(eq(proxies.isActive, true), lt(proxies.currentUsage, proxies.maxConcurrent)))
    .orderBy(asc(proxies.currentUsage), asc(proxies.lastUsedAt))
    .limit(1)
    .for('update');

  if (availableProxy.length === 0) {
    // Log why no proxy is available
    const proxyCount = await tx.select({ count: sql<number>`count(*)::int` }).from(proxies);
    const activeProxyCount = await tx.select({ count: sql<number>`count(*)::int` }).from(proxies).where(eq(proxies.isActive, true));
    const availableProxyCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(proxies)
      .where(and(eq(proxies.isActive, true), lt(proxies.currentUsage, proxies.maxConcurrent)));

    logger.warn(`[ResourceAllocator] No proxy available. Total: ${proxyCount[0]?.count ?? 0}, Active: ${activeProxyCount[0]?.count ?? 0}, Available: ${availableProxyCount[0]?.count ?? 0}`);
    return null;
  }

  const availableSession = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.isActive, true),
        lt(sessions.currentUsage, sessions.maxConcurrent)
      )
    )
    .orderBy(asc(sessions.currentUsage), asc(sessions.lastUsedAt))
    .limit(1)
    .for('update');

  if (availableSession.length === 0) {
    // Log why no session is available
    const sessionCount = await tx.select({ count: sql<number>`count(*)::int` }).from(sessions);
    const activeSessionCount = await tx.select({ count: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.isActive, true));
    const availableSessionCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.isActive, true), lt(sessions.currentUsage, sessions.maxConcurrent)));

    logger.warn(`[ResourceAllocator] No session available. Total: ${sessionCount[0]?.count ?? 0}, Active: ${activeSessionCount[0]?.count ?? 0}, Available: ${availableSessionCount[0]?.count ?? 0}`);
    return null;
  }

  await tx
    .update(proxies)
    .set({
      currentUsage: sql`${proxies.currentUsage} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(proxies.id, availableProxy[0].id));

  await tx
    .update(sessions)
    .set({
      currentUsage: sql`${sessions.currentUsage} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(sessions.id, availableSession[0].id));

  logger.debug(`[ResourceAllocator] Allocated proxy ${availableProxy[0].id} and session ${availableSession[0].id}`);

  return {
    proxy: availableProxy[0],
    session: availableSession[0],
  };
}

export async function allocateResources(db: Db): Promise<AllocatedResources | null> {
  return db.transaction((tx) => allocateResourcesTx(tx as Transaction));
}

export async function releaseResources(
  db: Db,
  proxyId: string,
  sessionId: string
): Promise<void> {
  await db.transaction(async (tx) => releaseResourcesTx(tx as Transaction, proxyId, sessionId));
}

export async function releaseResourcesTx(
  tx: Transaction,
  proxyId: string,
  sessionId: string
): Promise<void> {
  await tx
    .update(proxies)
    .set({
      // Use GREATEST to prevent negative values if called twice
      currentUsage: sql`GREATEST(${proxies.currentUsage} - 1, 0)`,
    })
    .where(eq(proxies.id, proxyId));

  await tx
    .update(sessions)
    .set({
      // Use GREATEST to prevent negative values if called twice
      currentUsage: sql`GREATEST(${sessions.currentUsage} - 1, 0)`,
    })
    .where(eq(sessions.id, sessionId));
}

/**
 * Reconcile currentUsage counters with actual in-progress scans.
 * Fixes leaked usage from crashes, canceled scans, or bugs.
 * Should run at startup and periodically.
 */
export async function reconcileResourceUsage(db: Db): Promise<void> {
  // Reset proxy currentUsage to actual number of processing scans assigned to each proxy
  await db.execute(sql`
    UPDATE proxies SET current_usage = COALESCE(sq.actual, 0)
    FROM (
      SELECT p.id, COUNT(q.id)::int AS actual
      FROM proxies p
      LEFT JOIN scan_queue q ON q.assigned_proxy_id = p.id AND q.status = 'processing'
      GROUP BY p.id
    ) sq
    WHERE proxies.id = sq.id AND proxies.current_usage != COALESCE(sq.actual, 0)
  `);

  // Reset session currentUsage to actual number of processing scans assigned to each session
  await db.execute(sql`
    UPDATE sessions SET current_usage = COALESCE(sq.actual, 0)
    FROM (
      SELECT s.id, COUNT(q.id)::int AS actual
      FROM sessions s
      LEFT JOIN scan_queue q ON q.assigned_session_id = s.id AND q.status = 'processing'
      GROUP BY s.id
    ) sq
    WHERE sessions.id = sq.id AND sessions.current_usage != COALESCE(sq.actual, 0)
  `);

  logger.info('[ResourceAllocator] Reconciled resource usage counters');
}
