import { eq, and, or, sql, desc, asc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { scanQueue, servers, agents, taskLogs } from '../db/schema.js';
import type { NewScanQueue, ScanQueue } from '../db/schema.js';
import { resolveServerIp, PrivateIpError, parseServerAddress } from './ipResolver.js';
import { allocateResourcesTx, releaseResourcesTx } from './resourceAllocator.js';
import {
  getRedisClient,
  safeRedisCommand,
  REDIS_KEYS,
} from '../db/redis.js';
import { logger } from '../logger.js';

export interface AddToQueueInput {
  servers: string[];
}

export interface AddToQueueResult {
  added: number;
  skipped: number;
  queued: Array<{ id: string; serverAddress: string; resolvedIp: string; port: number }>;
}

export interface ClaimedQueueItem {
  queueId: string;
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

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalServers: number;
}

export interface QueueEntryOptions {
  limit?: number;
  offset?: number;
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'all';
}

/**
 * Generate a unique key for deduplication based on resolvedIp + port only.
 * This allows multiple hostnames resolving to the same IP to be grouped together.
 */
function getDedupeKey(resolvedIp: string, port: number, _hostname: string | null): string {
  return `${resolvedIp}:${port}`;
}

/**
 * Parse a server address into hostname and check if port is specified
 */
function parseHostname(serverAddress: string): { hostname: string | null; port: number } {
  const trimmed = serverAddress.trim();
  const [hostPart, portPart] = trimmed.split(':');
  const host = (hostPart ?? trimmed).trim();

  // If the host is an IP address, hostname is null
  const isIp = /^[\d.]+$|^\[?[0-9a-fA-F:]+\]?$/.test(host);
  return {
    hostname: isIp ? null : host,
    port: portPart ? parseInt(portPart, 10) : 25565,
  };
}

/**
 * Add servers to the scan queue with Redis-accelerated duplicate detection
 */
export async function addToQueue(db: Db, input: AddToQueueInput): Promise<AddToQueueResult> {
  const redis = getRedisClient();

  // Resolve all server addresses
  const resolved = await Promise.all(
    input.servers.map(async (addr) => {
      try {
        const trimmed = addr.trim();
        const { hostname, port } = parseHostname(trimmed);
        const { host } = parseServerAddress(trimmed);
        return {
          address: trimmed,
          hostname,
          resolvedIp: await resolveServerIp(host),
          port: Number.isNaN(port) || port <= 0 ? 25565 : Math.min(65535, port),
        };
      } catch (error) {
        // Skip servers that resolve to private IPs (SSRF protection)
        if (error instanceof PrivateIpError) {
          return null;
        }
        throw error;
      }
    })
  );

  // Deduplicate within this batch
  const seenKeys = new Set<string>();
  const uniqueResolved: typeof resolved = [];
  for (const r of resolved) {
    if (!r || !r.address) continue;
    const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueResolved.push(r);
  }

  let skipped = 0;
  const toAdd: typeof uniqueResolved = [];

  // Check for existing duplicates in PostgreSQL
  const existingQueue = await db
    .select({ resolvedIp: scanQueue.resolvedIp, port: scanQueue.port, hostname: scanQueue.hostname })
    .from(scanQueue)
    .where(or(eq(scanQueue.status, 'pending'), eq(scanQueue.status, 'processing')));

  const queueKeys = new Set(
    existingQueue.map((r) => getDedupeKey(r.resolvedIp ?? '', r.port, r.hostname ?? ''))
  );

  for (const r of uniqueResolved) {
    if (!r) continue;
    const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
    if (queueKeys.has(key)) {
      skipped++;
      continue;
    }
    toAdd.push(r);
  }

  // Add to PostgreSQL using bulk insert
  const valuesToAdd = toAdd.map(r => ({
    serverAddress: r.address,
    hostname: r.hostname,
    resolvedIp: r.resolvedIp,
    port: r.port,
    status: 'pending' as const,
  }));

  const inserted = await db
    .insert(scanQueue)
    .values(valuesToAdd)
    .returning();

  const added: Array<{ id: string; serverAddress: string; resolvedIp: string; port: number }> = [];

  // Add each inserted item to Redis
  for (const item of inserted) {
    added.push({
      id: item.id,
      serverAddress: item.serverAddress,
      resolvedIp: item.resolvedIp ?? '',
      port: item.port,
    });

    // Find the original hostname for this item
    const originalItem = toAdd.find(r => r.address === item.serverAddress && r.port === item.port);

    // Add to Redis pending queue as a List (not Hash)
    await safeRedisCommand(async (client) => {
      const key = getDedupeKey(item.resolvedIp ?? '', item.port, item.hostname);
      const itemData = JSON.stringify({
        id: item.id,
        serverAddress: item.serverAddress,
        resolvedIp: item.resolvedIp,
        port: item.port,
        hostname: originalItem?.hostname ?? item.hostname,
      });
      // Try to push to the list - if WRONGTYPE error, clear old Hash data first
      try {
        // Push to the end of the list (RPUSH)
        await client.rpush(REDIS_KEYS.QUEUE_PENDING, itemData);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('WRONGTYPE')) {
          // Old Hash data exists, clear it
          await client.del(REDIS_KEYS.QUEUE_PENDING);
          await client.del(REDIS_KEYS.QUEUE_PROCESSING);
          // Retry the rpush
          await client.rpush(REDIS_KEYS.QUEUE_PENDING, itemData);
        } else {
          throw err;
        }
      }
      // Track in duplicates set
      await client.hset(REDIS_KEYS.QUEUE_DUPLICATES, key, item.id);
    });
  }

  return { added: added.length, skipped, queued: added };
}

/**
 * Claim next available server from the queue with resource allocation
 * Uses Redis for atomic O(1) operations when available, falls back to PostgreSQL
 */
export async function claimFromQueue(db: Db, agentId: string): Promise<ClaimedQueueItem | null> {
  const redis = getRedisClient();

  if (redis && redis.status === 'ready') {
    try {
      // Check if Redis queue is empty - if so, sync from PostgreSQL
      const redisPendingCount = await redis.llen(REDIS_KEYS.QUEUE_PENDING);
      if (redisPendingCount === 0) {
        await syncPostgresToRedis(db, redis);
      }

      // Try Redis first for fast claiming
      const result = await claimFromQueueRedis(db, redis, agentId);
      if (result !== null) {
        return result;
      }
      // Redis had items but couldn't claim (no resources)
      return null;
    } catch (err: unknown) {
      // Check if this is a WRONGTYPE error - means old Hash data exists
      if (err instanceof Error && err.message.includes('WRONGTYPE')) {
        // Clear the old Hash data and fall back to PostgreSQL
        await safeRedisCommand(async (client) => {
          await client.del(REDIS_KEYS.QUEUE_PENDING);
          await client.del(REDIS_KEYS.QUEUE_PROCESSING);
        });
      }
      // Fall back to PostgreSQL on any Redis error
    }
  }

  // Fallback to PostgreSQL
  return claimFromQueuePostgres(db, agentId);
}

/**
 * Sync pending items from PostgreSQL to Redis
 * Called when Redis queue is empty but PostgreSQL has items
 */
async function syncPostgresToRedis(
  db: Db,
  redis: NonNullable<ReturnType<typeof getRedisClient>>
): Promise<void> {
  try {
    // Get pending items from PostgreSQL
    const pendingItems = await db
      .select()
      .from(scanQueue)
      .where(eq(scanQueue.status, 'pending'))
      .limit(1000); // Sync up to 1000 items at a time

    if (pendingItems.length === 0) return;

    // Batch all Redis operations into a single pipeline (one round trip)
    const pipeline = redis.pipeline();
    for (const item of pendingItems) {
      const key = getDedupeKey(item.resolvedIp ?? '', item.port, item.hostname);
      const itemData = JSON.stringify({
        id: item.id,
        serverAddress: item.serverAddress,
        resolvedIp: item.resolvedIp,
        port: item.port,
        hostname: item.hostname,
      });
      pipeline.rpush(REDIS_KEYS.QUEUE_PENDING, itemData);
      pipeline.hset(REDIS_KEYS.QUEUE_DUPLICATES, key, item.id);
    }
    await pipeline.exec();
  } catch (err) {
    // Log but don't fail - sync is best-effort
    logger.error('[RedisQueueService] Error syncing PostgreSQL to Redis:', err);
  }
}

/**
 * Fast path: Claim from Redis List with atomic RPOPLPUSH
 */
async function claimFromQueueRedis(
  db: Db,
  redis: ReturnType<typeof getRedisClient>,
  agentId: string
): Promise<ClaimedQueueItem | null> {
  if (!redis) return null;

  // Atomically pop from end of pending and push to processing
  // Use lmove instead of deprecated rpoplpush (Redis 6.2+)
  const result = await redis.lmove(REDIS_KEYS.QUEUE_PENDING, REDIS_KEYS.QUEUE_PROCESSING, 'RIGHT', 'LEFT');
  if (!result) return null;

  let itemData: { id: string; serverAddress: string; resolvedIp: string; port: number; hostname: string | null };
  try {
    itemData = JSON.parse(result);
  } catch {
    // Invalid JSON, remove from processing and continue
    await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, result);
    return null;
  }

  // Store the queue ID in a separate key for reliable cleanup (not reliant on JSON matching)
  await redis.setex(REDIS_KEYS.QUEUE_ITEM(itemData.id), 300, agentId); // 5 min TTL

  try {
    // Use a single transaction for both resource allocation and queue updates
    return await db.transaction(async (tx) => {
      const resources = await allocateResourcesTx(tx);
      if (!resources) {
        // No resources available — remove the specific item from processing and push back to pending.
        // Using lrem + lpush instead of blind lmove to avoid moving a different agent's item.
        const itemJson = JSON.stringify({
          id: itemData.id,
          serverAddress: itemData.serverAddress,
          resolvedIp: itemData.resolvedIp,
          port: itemData.port,
          hostname: itemData.hostname,
        });
        await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, itemJson);
        await redis.lpush(REDIS_KEYS.QUEUE_PENDING, itemJson);
        await redis.del(REDIS_KEYS.QUEUE_ITEM(itemData.id));
        return null;
      }

      // Update PostgreSQL
      await tx
        .update(scanQueue)
        .set({
          status: 'processing',
          assignedAgentId: agentId,
          assignedProxyId: resources.proxy.id,
          assignedAccountId: resources.account.id,
          startedAt: new Date(),
        })
        .where(eq(scanQueue.id, itemData.id));

      // Update agent status
      await tx
        .update(agents)
        .set({ currentQueueId: itemData.id, status: 'busy' })
        .where(eq(agents.id, agentId));

      const protocol = (resources.proxy.protocol === 'socks4' ? 'socks4' : 'socks5') as 'socks4' | 'socks5';
      return {
        queueId: itemData.id,
        serverAddress: itemData.serverAddress,
        port: itemData.port,
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
  } catch (err) {
    // If anything fails, remove the specific item from processing and push back to pending.
    // Using lrem + lpush instead of blind lmove, which could pop a different agent's item.
    const itemJson = JSON.stringify({
      id: itemData.id,
      serverAddress: itemData.serverAddress,
      resolvedIp: itemData.resolvedIp,
      port: itemData.port,
      hostname: itemData.hostname,
    });
    await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, itemJson);
    await redis.lpush(REDIS_KEYS.QUEUE_PENDING, itemJson);
    await redis.del(REDIS_KEYS.QUEUE_ITEM(itemData.id));
    throw err;
  }
}

/**
 * Fallback: Claim from PostgreSQL with row-level locking
 */
async function claimFromQueuePostgres(db: Db, agentId: string): Promise<ClaimedQueueItem | null> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(scanQueue)
      .where(eq(scanQueue.status, 'pending'))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!item) return null;

    const resources = await allocateResourcesTx(tx);
    if (!resources) return null;

    await tx
      .update(scanQueue)
      .set({
        status: 'processing',
        assignedAgentId: agentId,
        assignedProxyId: resources.proxy.id,
        assignedAccountId: resources.account.id,
        startedAt: new Date(),
      })
      .where(eq(scanQueue.id, item.id));

    // Update agent status and currentQueueId
    await tx
      .update(agents)
      .set({ currentQueueId: item.id, status: 'busy' })
      .where(eq(agents.id, agentId));

    const protocol = (resources.proxy.protocol === 'socks4' ? 'socks4' : 'socks5') as 'socks4' | 'socks5';
    return {
      queueId: item.id,
      serverAddress: item.serverAddress,
      port: item.port,
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

/**
 * Get current queue status statistics
 * Uses Redis for fast counts when available
 */
export async function getQueueStatus(db: Db): Promise<QueueStatus> {
  const redis = getRedisClient();

  let pending = 0;
  let processing = 0;

  if (redis && redis.status === 'ready') {
    try {
      // Clean up orphaned processing items before getting counts
      await cleanupOrphanedProcessingItems(redis, db);

      // Fast path: Get list lengths from Redis
      pending = await redis.llen(REDIS_KEYS.QUEUE_PENDING) || 0;
      processing = await redis.llen(REDIS_KEYS.QUEUE_PROCESSING) || 0;
    } catch (err: unknown) {
      // Check if this is a WRONGTYPE error - means old Hash data exists
      if (err instanceof Error && err.message.includes('WRONGTYPE')) {
        // Clear the old Hash data and fall back to PostgreSQL
        await safeRedisCommand(async (client) => {
          await client.del(REDIS_KEYS.QUEUE_PENDING);
          await client.del(REDIS_KEYS.QUEUE_PROCESSING);
        });
        // Fall through to PostgreSQL query
      } else {
        // For other errors, fall back to PostgreSQL
        logger.error('[RedisQueueService] Redis queue status error:', err);
      }
      // Use PostgreSQL fallback
      const [pendingResult, processingResult] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'pending')),
        db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'processing')),
      ]);
      pending = pendingResult[0]?.count ?? 0;
      processing = processingResult[0]?.count ?? 0;
    }
  } else {
    // Fallback: Query PostgreSQL
    const [pendingResult, processingResult] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'pending')),
      db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'processing')),
    ]);
    pending = pendingResult[0]?.count ?? 0;
    processing = processingResult[0]?.count ?? 0;
  }

  // Completed/failed always come from PostgreSQL (historical data)
  const [completedResult, failedResult, totalServersResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'completed')),
    db.select({ count: sql<number>`count(*)::int` }).from(scanQueue).where(eq(scanQueue.status, 'failed')),
    db.select({ count: sql<number>`count(*)::int` }).from(servers),
  ]);

  return {
    pending,
    processing,
    completed: completedResult[0]?.count ?? 0,
    failed: failedResult[0]?.count ?? 0,
    totalServers: totalServersResult[0]?.count ?? 0,
  };
}

/**
 * Clean up orphaned items in the Redis processing list.
 * This handles cases where agents crashed after claiming but before completing.
 * An item is orphaned if it's in Redis processing but not in PostgreSQL processing,
 * or if the tracking key has expired (agent didn't heartbeat).
 */
async function cleanupOrphanedProcessingItems(
  redis: ReturnType<typeof getRedisClient>,
  db: Db
): Promise<void> {
  if (!redis) return;

  try {
    const processingList = await redis.lrange(REDIS_KEYS.QUEUE_PROCESSING, 0, -1);
    if (processingList.length === 0) return;

    // Get all currently processing IDs from PostgreSQL
    const pgProcessing = await db
      .select({ id: scanQueue.id })
      .from(scanQueue)
      .where(eq(scanQueue.status, 'processing'));

    const pgProcessingIds = new Set(pgProcessing.map((item) => item.id));

    for (const itemStr of processingList) {
      try {
        const parsed = JSON.parse(itemStr);
        const itemId = parsed.id;

        // Check if tracking key exists (should exist if actively processing)
        const trackingKey = REDIS_KEYS.QUEUE_ITEM(itemId);
        const trackingExists = await redis.exists(trackingKey);

        // Remove from Redis processing if:
        // 1. Not in PostgreSQL processing anymore, OR
        // 2. Tracking key expired (agent crashed/timeout)
        if (!pgProcessingIds.has(itemId) || trackingExists === 0) {
          await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, itemStr);
          // Also clean up the tracking key if it exists
          if (trackingExists === 1) {
            await redis.del(trackingKey);
          }
        }
      } catch {
        // Invalid JSON - remove it
        await redis.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, itemStr);
      }
    }
  } catch (err) {
    // Log but don't fail - cleanup is best-effort
    logger.error('[RedisQueueService] Error during Redis processing list cleanup:', err);
  }
}

/**
 * Get scan queue entries with pagination and optional status filter
 */
export async function getQueueEntries(db: Db, options: QueueEntryOptions = {}): Promise<typeof scanQueue.$inferSelect[]> {
  const { limit = 100, offset = 0, status = 'all' } = options;

  const baseQuery = db.select().from(scanQueue);

  const query = status !== 'all'
    ? baseQuery.where(eq(scanQueue.status, status))
    : baseQuery;

  return query
    .orderBy(scanQueue.createdAt)
    .limit(limit)
    .offset(offset);
}

/**
 * Complete a scan - update server history and remove from queue
 */
export async function completeScan(
  db: Db,
  queueId: string,
  result: unknown,
  errorMessage?: string
): Promise<void> {
  const redis = getRedisClient();

  // Single transactional fetch with row-level locking (no double query)
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(scanQueue)
      .where(eq(scanQueue.id, queueId))
      .for('update')
      .limit(1);

    if (!item) return;

    // Idempotency check: skip if already completed or failed
    if (item.status === 'completed' || item.status === 'failed') {
      return;
    }

    // Release resources within the same transaction to prevent inconsistency
    if (item.assignedProxyId && item.assignedAccountId) {
      await releaseResourcesTx(tx, item.assignedProxyId, item.assignedAccountId);
    }

    // Clear agent's currentQueueId and set status to idle
    if (item.assignedAgentId) {
      await tx
        .update(agents)
        .set({ currentQueueId: null, status: 'idle' })
        .where(eq(agents.id, item.assignedAgentId));
    }

    // Build scan history entry - use same timestamp for consistency
    const completedAt = new Date();
    const duration = item.startedAt ? completedAt.getTime() - new Date(item.startedAt).getTime() : null;

    // Fetch all logs for this queue item before deleting it
    const logs = await tx
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.queueId, queueId))
      .orderBy(desc(taskLogs.timestamp))
      .limit(500); // Get up to 500 most recent log lines

    const historyEntry = {
      timestamp: completedAt.toISOString(),
      result: errorMessage ? null : result,
      errorMessage: errorMessage ?? undefined,
      duration: duration,
      logs: logs.map(log => ({
        level: log.level,
        message: log.message,
        timestamp: log.timestamp?.toISOString() ?? completedAt.toISOString(),
      })),
    };

    // Update or create server record - group by resolvedIp + port only
    const existingServer = await tx
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.resolvedIp, item.resolvedIp ?? ''),
          eq(servers.port, item.port)
        )
      )
      .limit(1);

    if (existingServer.length > 0) {
      // Update existing server - append hostname to hostnames array if new
      const server = existingServer[0]!;
      const currentHistory = (server.scanHistory as unknown as Array<typeof historyEntry>) ?? [];
      const updatedHistory = [historyEntry, ...currentHistory].slice(0, 100); // Keep last 100 scans

      // Get current hostnames array, or initialize from legacy hostname field
      const currentHostnames: string[] = Array.isArray(server.hostnames)
        ? server.hostnames as string[]
        : (server.hostname ? [server.hostname] : []);

      // Add new hostname if it exists and isn't already in the array
      const newHostnames = item.hostname
        ? (currentHostnames.includes(item.hostname)
          ? currentHostnames
          : [...currentHostnames, item.hostname])
        : currentHostnames;

      await tx
        .update(servers)
        .set({
          lastScannedAt: completedAt,
          scanCount: sql`${servers.scanCount} + 1`,
          latestResult: result ? (result as object) : null,
          scanHistory: updatedHistory as any,
          hostnames: newHostnames as any,
          // Only set primaryHostname if not already set
          ...(server.primaryHostname ? {} : { primaryHostname: item.hostname }),
        })
        .where(eq(servers.id, server.id));
    } else {
      // Create new server record with hostname tracking
      await tx.insert(servers).values({
        serverAddress: item.serverAddress,
        hostname: item.hostname,
        resolvedIp: item.resolvedIp,
        port: item.port,
        hostnames: item.hostname ? [item.hostname] : [],
        primaryHostname: item.hostname ?? null,
        firstSeenAt: completedAt,
        lastScannedAt: completedAt,
        scanCount: 1,
        latestResult: result ? (result as object) : null,
        scanHistory: [historyEntry] as any,
      });
    }

    // Mark queue item as completed
    await tx
      .update(scanQueue)
      .set({
        status: errorMessage ? 'failed' : 'completed',
        errorMessage: errorMessage ?? null,
        completedAt: completedAt,
      })
      .where(eq(scanQueue.id, queueId));

    // Remove from PostgreSQL queue
    await tx.delete(scanQueue).where(eq(scanQueue.id, queueId));

    // Remove from Redis processing list and duplicates set (inside transaction closure for data access)
    if (redis && redis.status === 'ready') {
      const dedupeKey = getDedupeKey(item.resolvedIp ?? '', item.port, item.hostname);
      // Build the exact JSON that was stored when the item was claimed (for lrem matching)
      const storedJson = JSON.stringify({
        id: item.id,
        serverAddress: item.serverAddress,
        resolvedIp: item.resolvedIp,
        port: item.port,
        hostname: item.hostname,
      });
      await safeRedisCommand(async (client) => {
        // Pipeline all cleanup operations in a single round trip
        const pipeline = client.pipeline();
        pipeline.del(REDIS_KEYS.QUEUE_ITEM(queueId));
        pipeline.hdel(REDIS_KEYS.QUEUE_DUPLICATES, dedupeKey);
        // O(1) targeted removal using the exact stored JSON instead of O(n) lrange scan
        pipeline.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, storedJson);
        await pipeline.exec();
      });
    }
  });
}

/**
 * Fail a scan - remove from queue with cleanup
 */
export async function failScan(db: Db, queueId: string, errorMessage: string): Promise<void> {
  await completeScan(db, queueId, null, errorMessage);
}

/**
 * Get list of all servers with pagination
 */
export async function listServers(db: Db, options: { limit?: number; offset?: number } = {}): Promise<typeof servers.$inferSelect[]> {
  const { limit = 100, offset = 0 } = options;
  return db
    .select()
    .from(servers)
    .orderBy(desc(servers.lastScannedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get server by ID with full scan history
 */
export async function getServer(db: Db, serverId: string): Promise<typeof servers.$inferSelect | null> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  return server ?? null;
}

/**
 * Delete a server record
 */
export async function deleteServer(db: Db, serverId: string): Promise<boolean> {
  const result = await db.delete(servers).where(eq(servers.id, serverId)).returning();
  return result.length > 0;
}

/**
 * Recover tasks stuck in "processing" state for too long.
 * This handles cases where:
 * - The agent crashed without reporting back
 * - The agent reported completion but the coordinator failed to process it
 * - Network issues prevented the completion/failure request from reaching the coordinator
 *
 * Tasks stuck for longer than the timeout are automatically failed with cleanup.
 */
const STUCK_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (scan timeout is 60s + buffer)

export async function recoverStuckTasks(db: Db): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS);

    // Find tasks stuck in processing that started before the cutoff
    const stuckTasks = await db
      .select({ id: scanQueue.id, serverAddress: scanQueue.serverAddress, startedAt: scanQueue.startedAt })
      .from(scanQueue)
      .where(
        and(
          eq(scanQueue.status, 'processing'),
          sql`${scanQueue.startedAt} < ${cutoff}`
        )
      );

    if (stuckTasks.length === 0) return 0;

    logger.info(`[StuckTaskRecovery] Found ${stuckTasks.length} stuck task(s), recovering...`);

    for (const task of stuckTasks) {
      try {
        await failScan(
          db,
          task.id,
          `Task automatically recovered: stuck in processing for over ${Math.round(STUCK_TASK_TIMEOUT_MS / 60000)} minutes (agent may have crashed or lost connection)`
        );
        logger.info(`[StuckTaskRecovery] Recovered task ${task.id} (${task.serverAddress})`);
      } catch (err) {
        logger.error(`[StuckTaskRecovery] Failed to recover task ${task.id}:`, err);
      }
    }

    return stuckTasks.length;
  } catch (err) {
    logger.error('[StuckTaskRecovery] Error during stuck task recovery:', err);
    return 0;
  }
}

/**
 * Start a periodic interval to recover stuck tasks.
 * Returns the interval handle for cleanup.
 */
export function startStuckTaskRecovery(db: Db, intervalMs: number = 60_000): ReturnType<typeof setInterval> {
  logger.info(`[StuckTaskRecovery] Started (checking every ${intervalMs / 1000}s, timeout: ${STUCK_TASK_TIMEOUT_MS / 1000}s)`);
  return setInterval(() => {
    recoverStuckTasks(db).catch((err) => {
      logger.error('[StuckTaskRecovery] Unhandled error:', err);
    });
  }, intervalMs);
}

/**
 * Delete a specific scan entry from server's scan history
 * @param db Database instance
 * @param serverId Server ID
 * @param timestamp Timestamp of the scan to delete (ISO string)
 * @returns true if deleted, false if not found
 */
export async function deleteScanHistory(db: Db, serverId: string, timestamp: string): Promise<boolean> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) return false;

  const history = (server.scanHistory as unknown as Array<{ timestamp: string; result?: unknown; errorMessage?: string }>) ?? [];
  const filteredHistory = history.filter(h => h.timestamp !== timestamp);

  if (filteredHistory.length === history.length) return false; // No matching entry found

  // Update scan count
  const newScanCount = Math.max(0, (server.scanCount ?? 1) - 1);

  // If we deleted the most recent scan, update latestResult and lastScannedAt
  const sortedHistory = [...filteredHistory].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const newLatestResult = sortedHistory[0]?.result ?? null;
  const newLastScannedAt = sortedHistory[0]?.timestamp
    ? new Date(sortedHistory[0].timestamp)
    : server.firstSeenAt ?? null;

  await db
    .update(servers)
    .set({
      scanHistory: filteredHistory as any,
      scanCount: newScanCount,
      latestResult: newLatestResult,
      lastScannedAt: newLastScannedAt,
    })
    .where(eq(servers.id, serverId));

  // If no scans left, optionally delete the server record entirely
  if (filteredHistory.length === 0) {
    await db.delete(servers).where(eq(servers.id, serverId));
  }

  return true;
}
