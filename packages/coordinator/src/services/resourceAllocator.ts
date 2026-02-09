import { and, eq, lt, asc, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { proxies, accounts } from '../db/schema.js';
import type { Proxy, Account } from '../db/schema.js';

export interface AllocatedResources {
  proxy: Proxy;
  account: Account;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function allocateResourcesTx(tx: Tx): Promise<AllocatedResources | null> {
  const availableProxy = await tx
    .select()
    .from(proxies)
    .where(and(eq(proxies.isActive, true), lt(proxies.currentUsage, proxies.maxConcurrent)))
    .orderBy(asc(proxies.currentUsage), asc(proxies.lastUsedAt))
    .limit(1)
    .for('update');

  if (availableProxy.length === 0) return null;

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

  if (availableAccount.length === 0) return null;

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

  return {
    proxy: availableProxy[0],
    account: availableAccount[0],
  };
}

export async function allocateResources(db: Db, _agentId: string): Promise<AllocatedResources | null> {
  return db.transaction((tx) => allocateResourcesTx(tx));
}

export async function releaseResources(
  db: Db,
  proxyId: string,
  accountId: string
): Promise<void> {
  await db.transaction(async (tx) => releaseResourcesTx(tx, proxyId, accountId));
}

export async function releaseResourcesTx(
  tx: Tx,
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
