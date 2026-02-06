import { eq, and, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { batches, tasks, agents } from '../db/schema.js';
import type { NewBatch, NewTask } from '../db/schema.js';
import { resolveServerIp, PrivateIpError } from './ipResolver.js';
import { allocateResourcesTx, releaseResources } from './resourceAllocator.js';

export interface CreateBatchInput {
  servers: string[];
  name?: string;
}

export interface CreateBatchResult {
  batchId: string;
  totalTasks: number;
  skippedDuplicates: number;
}

export async function createBatch(db: Db, input: CreateBatchInput): Promise<CreateBatchResult> {
  const resolved = await Promise.all(
    input.servers.map(async (addr) => {
      try {
        return {
          address: addr.trim(),
          resolvedIp: await resolveServerIp(addr),
        };
      } catch (error) {
        // Skip servers that resolve to private IPs (SSRF protection)
        if (error instanceof PrivateIpError) {
          return null; // Skip this server
        }
        throw error; // Re-throw other errors
      }
    })
  );

  const seenIps = new Set<string>();
  const uniqueResolved: { address: string; resolvedIp: string }[] = [];
  for (const r of resolved) {
    // Skip null entries (servers rejected due to private IP resolution)
    if (!r || !r.address) continue;
    if (seenIps.has(r.resolvedIp)) continue;
    seenIps.add(r.resolvedIp);
    uniqueResolved.push(r);
  }

  const [batch] = await db
    .insert(batches)
    .values({
      name: input.name ?? null,
      status: 'pending',
      totalTasks: uniqueResolved.length,
      completedTasks: 0,
    } as NewBatch)
    .returning();

  if (!batch) throw new Error('Failed to create batch');

  const processingIps = await db
    .select({ ip: tasks.resolvedIp })
    .from(tasks)
    .where(eq(tasks.status, 'processing'));
  const processingSet = new Set(processingIps.map((r) => r.ip).filter(Boolean));

  let skipped = 0;
  for (const r of uniqueResolved) {
    const port = r.address.includes(':')
      ? parseInt(r.address.split(':')[1] ?? '25565', 10)
      : 25565;
    const status = processingSet.has(r.resolvedIp) ? 'skipped' : 'pending';
    if (status === 'skipped') skipped++;
    await db.insert(tasks).values({
      batchId: batch.id,
      serverAddress: r.address,
      resolvedIp: r.resolvedIp,
      port: Number.isNaN(port) || port <= 0 ? 25565 : Math.min(65535, port),
      status,
    } as NewTask);
  }

  return {
    batchId: batch.id,
    totalTasks: uniqueResolved.length,
    skippedDuplicates: skipped,
  };
}

export interface ClaimedTask {
  taskId: string;
  serverAddress: string;
  port: number;
  proxy: {
    id: string;
    host: string;
    port: number;
    type: 'socks4' | 'socks5';
    username?: string;
    password?: string;
  };
  account: {
    id: string;
    type: string;
    username?: string;
    accessToken?: string;
    refreshToken?: string;
  };
}

export async function claimTask(db: Db, agentId: string): Promise<ClaimedTask | null> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'pending'))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!task) return null;

    // Check if the batch is cancelled before claiming the task
    if (task.batchId) {
      const [batch] = await tx.select().from(batches).where(eq(batches.id, task.batchId)).limit(1);
      if (batch && (batch.status === 'cancelled' || batch.status === 'completed')) {
        // Skip tasks from cancelled or completed batches
        return null;
      }
    }

    const resources = await allocateResourcesTx(tx);
    if (!resources) return null;

    await tx
      .update(tasks)
      .set({
        status: 'processing',
        assignedAgentId: agentId,
        assignedProxyId: resources.proxy.id,
        assignedAccountId: resources.account.id,
        startedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    // Update agent status and currentTaskId
    await tx
      .update(agents)
      .set({ currentTaskId: task.id, status: 'busy' })
      .where(eq(agents.id, agentId));

    if (task.batchId) {
      // Only update batch status if it's not already cancelled or completed
      await tx
        .update(batches)
        .set({ status: 'processing' })
        .where(and(eq(batches.id, task.batchId), sql`status NOT IN ('cancelled', 'completed')`));
    }

    const protocol = (resources.proxy.protocol === 'socks4' ? 'socks4' : 'socks5') as 'socks4' | 'socks5';
    return {
      taskId: task.id,
      serverAddress: task.serverAddress,
      port: task.port,
      proxy: {
        id: resources.proxy.id,
        host: resources.proxy.host,
        port: resources.proxy.port,
        type: protocol,
        username: resources.proxy.username ?? undefined,
        password: resources.proxy.password ?? undefined,
      },
      account: {
        id: resources.account.id,
        type: resources.account.type,
        username: resources.account.username ?? undefined,
        accessToken: resources.account.accessToken ?? undefined,
        refreshToken: resources.account.refreshToken ?? undefined,
      },
    };
  });
}

export async function completeTask(
  db: Db,
  taskId: string,
  result: unknown,
  errorMessage?: string
): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return;

  if (task.assignedProxyId && task.assignedAccountId) {
    await releaseResources(db, task.assignedProxyId, task.assignedAccountId);
  }

  // Clear agent's currentTaskId and set status to idle
  if (task.assignedAgentId) {
    await db
      .update(agents)
      .set({ currentTaskId: null, status: 'idle' })
      .where(eq(agents.id, task.assignedAgentId));
  }

  await db
    .update(tasks)
    .set({
      status: errorMessage ? 'failed' : 'completed',
      result: result ? (result as object) : null,
      errorMessage: errorMessage ?? null,
      completedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  const [batchRow] = await db.select().from(batches).where(eq(batches.id, task.batchId!)).limit(1);
  if (batchRow) {
    // Don't update batch status if it's already cancelled or completed
    if (batchRow.status === 'cancelled' || batchRow.status === 'completed') {
      return;
    }

    const doneCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.batchId, batchRow.id),
          or(
            eq(tasks.status, 'completed'),
            eq(tasks.status, 'failed'),
            eq(tasks.status, 'cancelled'),
            eq(tasks.status, 'skipped')
          )
        )
      );
    const totalDone = doneCount[0]?.count ?? 0;
    const totalInBatch = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.batchId, batchRow.id));
    const total = totalInBatch[0]?.count ?? 0;
    const allDone = total > 0 && totalDone >= total;
    await db
      .update(batches)
      .set({
        completedTasks: totalDone,
        status: allDone ? 'completed' : 'processing',
        completedAt: allDone ? new Date() : undefined,
      })
      .where(eq(batches.id, batchRow.id));
  }
}

export async function failTask(db: Db, taskId: string, errorMessage: string): Promise<void> {
  await completeTask(db, taskId, null, errorMessage);
}

/**
 * Cancel a batch - marks all pending/processing tasks as cancelled
 * Releases resources for any processing tasks
 */
export async function cancelBatch(db: Db, batchId: string): Promise<{ cancelledCount: number; releasedCount: number }> {
  // Find all pending and processing tasks for this batch
  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.batchId, batchId));

  let cancelledCount = 0;
  let releasedCount = 0;

  for (const task of allTasks) {
    if (task.status === 'pending') {
      // Mark pending tasks as cancelled
      await db
        .update(tasks)
        .set({ status: 'cancelled' })
        .where(eq(tasks.id, task.id));
      cancelledCount++;
    } else if (task.status === 'processing') {
      // Release resources for processing tasks and mark as cancelled
      if (task.assignedProxyId && task.assignedAccountId) {
        await releaseResources(db, task.assignedProxyId, task.assignedAccountId);
        releasedCount++;
      }
      await db
        .update(tasks)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(tasks.id, task.id));
      cancelledCount++;
    }
  }

  // Update batch status to cancelled and set completedTasks count
  const totalTasks = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(eq(tasks.batchId, batchId));

  const total = totalTasks[0]?.count ?? 0;

  await db
    .update(batches)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      completedTasks: cancelledCount,
    })
    .where(eq(batches.id, batchId));

  return { cancelledCount, releasedCount };
}

/**
 * Delete a batch and all its tasks
 * Must clear agent references first due to foreign key constraint
 */
export async function deleteBatch(db: Db, batchId: string): Promise<{ deletedCount: number }> {
  // First, null out any agent references to tasks in this batch
  const batchTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.batchId, batchId));

  for (const task of batchTasks) {
    await db
      .update(agents)
      .set({ currentTaskId: null })
      .where(eq(agents.currentTaskId, task.id));
  }

  // Then delete all tasks for this batch
  const deletedTasks = await db
    .delete(tasks)
    .where(eq(tasks.batchId, batchId))
    .returning();

  // Finally delete the batch
  await db.delete(batches).where(eq(batches.id, batchId));

  return { deletedCount: deletedTasks.length };
}
