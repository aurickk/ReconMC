import { and, eq, lt, asc, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { proxies, accounts } from '../db/schema.js';
import type { Proxy, Account } from '../db/schema.js';
import { logger } from '../logger.js';

export interface AllocatedResources {
  proxy: Proxy;
  account: Account;
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

  const availableAccount = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.isActive, true),
        eq(accounts.isValid, true),
        lt(accounts.currentUsage, accounts.maxConcurrent)
      )
    )
    .orderBy(asc(accounts.currentUsage), asc(accounts.lastUsedAt))
    .limit(1)
    .for('update');

  if (availableAccount.length === 0) {
    // Log why no account is available
    const accountCount = await tx.select({ count: sql<number>`count(*)::int` }).from(accounts);
    const activeAccountCount = await tx.select({ count: sql<number>`count(*)::int` }).from(accounts).where(eq(accounts.isActive, true));
    const validAccountCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(accounts)
      .where(and(eq(accounts.isActive, true), eq(accounts.isValid, true)));
    const availableAccountCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(accounts)
      .where(and(eq(accounts.isActive, true), eq(accounts.isValid, true), lt(accounts.currentUsage, accounts.maxConcurrent)));

    logger.warn(`[ResourceAllocator] No account available. Total: ${accountCount[0]?.count ?? 0}, Active: ${activeAccountCount[0]?.count ?? 0}, Valid: ${validAccountCount[0]?.count ?? 0}, Available: ${availableAccountCount[0]?.count ?? 0}`);
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
    .update(accounts)
    .set({
      currentUsage: sql`${accounts.currentUsage} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(accounts.id, availableAccount[0].id));

  logger.debug(`[ResourceAllocator] Allocated proxy ${availableProxy[0].id} and account ${availableAccount[0].id}`);

  return {
    proxy: availableProxy[0],
    account: availableAccount[0],
  };
}

export async function allocateResources(db: Db, _agentId: string): Promise<AllocatedResources | null> {
  return db.transaction((tx) => allocateResourcesTx(tx as Transaction));
}

export async function releaseResources(
  db: Db,
  proxyId: string,
  accountId: string
): Promise<void> {
  await db.transaction(async (tx) => releaseResourcesTx(tx as Transaction, proxyId, accountId));
}

export async function releaseResourcesTx(
  tx: Transaction,
  proxyId: string,
  accountId: string
): Promise<void> {
  await tx
    .update(proxies)
    .set({
      // Use GREATEST to prevent negative values if called twice
      currentUsage: sql`GREATEST(${proxies.currentUsage} - 1, 0)`,
    })
    .where(eq(proxies.id, proxyId));

  await tx
    .update(accounts)
    .set({
      // Use GREATEST to prevent negative values if called twice
      currentUsage: sql`GREATEST(${accounts.currentUsage} - 1, 0)`,
    })
    .where(eq(accounts.id, accountId));
}
