import { eq, and, or, sql, desc, asc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { scanQueue, servers, agents, taskLogs, proxies, sessions } from '../db/schema.js';
import { buildSelectColumns } from '../utils/excludeFields.js';
import type { NewScanQueue, ScanQueue } from '../db/schema.js';
import { resolveServerIp, PrivateIpError, parseServerAddress } from './ipResolver.js';
import { allocateResourcesTx, releaseResourcesTx, reconcileResourceUsage, type Transaction } from './resourceAllocator.js';
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
  session: {
    id: string;
    username?: string;
    accessToken?: string;
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
 * Generate a unique key for deduplication based on hostname + port.
 * Uses hostname when available (stable across DNS changes), falls back to resolvedIp for raw IP inputs.
 */
function getDedupeKey(resolvedIp: string, port: number, hostname: string | null): string {
  return hostname ? `h:${hostname.toLowerCase()}:${port}` : `ip:${resolvedIp}:${port}`;
}

/**
 * Parse a server address into hostname and check if port is specified.
 *
 * NOTE: This is intentionally separate from `parseServerAddress()` in ipResolver.ts.
 * `parseServerAddress` returns { host, port } where host is always the raw string.
 * This function additionally determines whether the host is an IP address and
 * returns `hostname: null` for IPs (used for hostname tracking in scan queue entries).
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

  // Check for existing duplicates using Redis duplicates hash (O(1) per lookup)
  // Fall back to targeted PostgreSQL queries only for items not in Redis
  const redisDupKeys = new Set<string>();

  if (redis && redis.status === 'ready') {
    try {
      // Batch check all keys in Redis duplicates hash
      const pipeline = redis.pipeline();
      for (const r of uniqueResolved) {
        if (!r) continue;
        const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
        pipeline.hexists(REDIS_KEYS.QUEUE_DUPLICATES, key);
      }
      const results = await pipeline.exec();

      for (let i = 0; i < uniqueResolved.length; i++) {
        const r = uniqueResolved[i];
        if (!r) continue;
        const [err, exists] = results?.[i] ?? [null, 0];
        if (!err && exists === 1) {
          const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
          redisDupKeys.add(key);
        }
      }
    } catch (err) {
      logger.warn('[RedisQueueService] Redis duplicate check failed, falling back to PostgreSQL:', err);
    }
  }

  // For items not found in Redis, check PostgreSQL using targeted queries with unique index
  // This is much faster than fetching all pending/processing rows
  const needsPgCheck = uniqueResolved.filter(r => {
    if (!r) return false;
    const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
    return !redisDupKeys.has(key);
  });

  // Batch PostgreSQL check using a single query with IN clause
  if (needsPgCheck.length > 0) {
    // Build conditions for each unique (hostname, port) or (resolvedIp, port) pair
    const conditions = needsPgCheck
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(r => r.hostname
        ? and(eq(scanQueue.hostname, r.hostname), eq(scanQueue.port, r.port))
        : and(eq(scanQueue.resolvedIp, r.resolvedIp), eq(scanQueue.port, r.port))
      );

    if (conditions.length > 0) {
      // Query in batches to avoid overly large queries
      const CHECK_BATCH_SIZE = 100;
      for (let i = 0; i < conditions.length; i += CHECK_BATCH_SIZE) {
        const batchConditions = conditions.slice(i, i + CHECK_BATCH_SIZE);
        const existingInPg = await db
          .select({ resolvedIp: scanQueue.resolvedIp, port: scanQueue.port, hostname: scanQueue.hostname })
          .from(scanQueue)
          .where(or(...batchConditions));

        for (const existing of existingInPg) {
          const key = getDedupeKey(existing.resolvedIp ?? '', existing.port, existing.hostname);
          redisDupKeys.add(key);
        }
      }
    }
  }

  for (const r of uniqueResolved) {
    if (!r) continue;
    const key = getDedupeKey(r.resolvedIp, r.port, r.hostname);
    if (redisDupKeys.has(key)) {
      skipped++;
      continue;
    }
    toAdd.push(r);
  }

  // Add to PostgreSQL using bulk insert in batches to avoid stack overflow
  const valuesToAdd = toAdd.filter((r): r is NonNullable<typeof r> => r !== null).map(r => ({
    serverAddress: r.address,
    hostname: r.hostname,
    resolvedIp: r.resolvedIp,
    port: r.port,
    status: 'pending' as const,
  }));

  // Batch insert to avoid Drizzle query builder stack overflow on large datasets
  const BATCH_SIZE = 500;
  const inserted: Array<{ id: string; serverAddress: string; hostname: string | null; resolvedIp: string | null; port: number }> = [];

  for (let i = 0; i < valuesToAdd.length; i += BATCH_SIZE) {
    const batch = valuesToAdd.slice(i, i + BATCH_SIZE);
    const result = await db
      .insert(scanQueue)
      .values(batch)
      .returning();
    inserted.push(...result);
  }

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
    const originalItem = toAdd.find((r) => r !== null && r.address === item.serverAddress && r.port === item.port);

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
      const resources = await allocateResourcesTx(tx as Transaction);
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
          assignedSessionId: resources.session.id,
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
        session: {
          id: resources.session.id,
          username: resources.session.username ?? undefined,
          accessToken: resources.session.accessToken ?? undefined,
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

    const resources = await allocateResourcesTx(tx as Transaction);
    if (!resources) return null;

    await tx
      .update(scanQueue)
      .set({
        status: 'processing',
        assignedAgentId: agentId,
        assignedProxyId: resources.proxy.id,
        assignedSessionId: resources.session.id,
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
      session: {
        id: resources.session.id,
        username: resources.session.username ?? undefined,
        accessToken: resources.session.accessToken ?? undefined,
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

    const pgProcessingIds = new Set(pgProcessing.map((item: { id: string }) => item.id));

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
 * Extract MOTD text from Minecraft description (string or chat component)
 */
function extractMotd(description: unknown): string | null {
  if (!description) return null;
  if (typeof description === 'string') return description;
  if (typeof description === 'object' && description !== null) {
    const desc = description as Record<string, unknown>;
    let text = typeof desc.text === 'string' ? desc.text : '';
    if (Array.isArray(desc.extra)) {
      for (const part of desc.extra) {
        if (typeof part === 'string') text += part;
        else if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          text += (part as Record<string, unknown>).text;
        }
      }
    }
    return text || null;
  }
  return null;
}

/**
 * Transform agent FullScanResult into the flat ServerScanResult shape
 * the dashboard expects (online, version, motd, playersOnline, etc.)
 */
function transformScanResult(raw: unknown): object | null {
  if (!raw || typeof raw !== 'object') return null;

  const r = raw as Record<string, unknown>;
  const ping = r.ping as Record<string, unknown> | undefined;
  const conn = r.connection as Record<string, unknown> | undefined;

  if (!ping) return null;

  const status = ping.status as Record<string, unknown> | undefined;
  const data = status?.data as Record<string, unknown> | undefined;
  const version = data?.version as Record<string, unknown> | undefined;
  const players = data?.players as Record<string, unknown> | undefined;
  const location = ping.location as Record<string, unknown> | undefined;
  const serverPlugins = conn?.serverPlugins as Record<string, unknown> | undefined;
  const serverCommands = conn?.serverCommands as Record<string, unknown> | undefined;

  return {
    online: ping.success === true,
    version: (version?.name as string) ?? null,
    protocol: (version?.protocol as number) ?? null,
    motd: extractMotd(data?.description),
    playersOnline: (players?.online as number) ?? null,
    playersMax: (players?.max as number) ?? null,
    players: Array.isArray(players?.sample) ? players.sample : null,
    icon: (data?.favicon as string) ?? null,
    latency: (status?.latency as number) ?? null,
    plugins: Array.isArray(serverPlugins?.plugins)
      ? (serverPlugins.plugins as string[]).map((p: string) => ({ name: p, version: '' }))
      : null,
    pluginMethod: (serverPlugins?.method as string) ?? null,
    commands: Array.isArray(serverCommands?.commands) ? serverCommands.commands as string[] : null,
    commandMethod: (serverCommands?.method as string) ?? null,
    geo: location ? {
      country: (location.countryName as string) ?? null,
      countryCode: (location.country as string) ?? null,
      city: (location.city as string) ?? null,
      isp: (location.isp as string) ?? null,
    } : null,
    accountType: (conn?.accountType as string) ?? null,
    serverMode: (r.serverMode as string) ?? null,
    connection: conn ? {
      success: conn.success === true,
      username: (conn.username as string) ?? undefined,
      uuid: (conn.uuid as string) ?? undefined,
      accountType: (conn.accountType as string) ?? undefined,
      spawnPosition: conn.spawnPosition ?? undefined,
      serverAuth: conn.serverAuth ?? undefined,
      error: conn.error ?? undefined,
    } : null,
  };
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

    // Release resources within the same transaction to prevent inconsistency.
    // Handle proxy and session independently -- session may have been deleted
    // by /sessions/:id/invalidate (which sets assignedSessionId to NULL via FK cascade).
    if (item.assignedProxyId) {
      await tx
        .update(proxies)
        .set({ currentUsage: sql`GREATEST(${proxies.currentUsage} - 1, 0)` })
        .where(eq(proxies.id, item.assignedProxyId));
    }
    if (item.assignedSessionId) {
      await tx
        .update(sessions)
        .set({ currentUsage: sql`GREATEST(${sessions.currentUsage} - 1, 0)` })
        .where(eq(sessions.id, item.assignedSessionId));
    }

    // Clear agent's currentQueueId and set status to idle
    if (item.assignedAgentId) {
      await tx
        .update(agents)
        .set({ currentQueueId: null, status: 'idle' })
        .where(eq(agents.id, item.assignedAgentId));
    }

    // Transform raw agent result into the flat shape the dashboard expects
    const transformedResult = errorMessage ? null : transformScanResult(result);

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
      result: transformedResult,
      errorMessage: errorMessage ?? undefined,
      duration: duration,
      logs: logs.map((log: { level: string; message: string; timestamp?: Date }) => ({
        level: log.level,
        message: log.message,
        timestamp: log.timestamp?.toISOString() ?? completedAt.toISOString(),
      })),
    };

    // Update or create server record - group by hostname + port (or resolvedIp + port for raw IPs)
    const existingServer = await tx
      .select()
      .from(servers)
      .where(
        item.hostname
          ? and(eq(servers.hostname, item.hostname), eq(servers.port, item.port))
          : and(eq(servers.resolvedIp, item.resolvedIp ?? ''), eq(servers.port, item.port))
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
          latestResult: transformedResult,
          scanHistory: updatedHistory as any,
          hostnames: newHostnames as any,
          // Keep resolvedIp up to date with the latest DNS result
          ...(item.resolvedIp ? { resolvedIp: item.resolvedIp } : {}),
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
        latestResult: transformedResult,
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
 * Requeue a scan - release resources and put back to pending status.
 * Used when a scan cannot complete due to exhausted sessions (all auth tokens invalid).
 * The task stays in the queue and will be picked up again when new sessions are available.
 */
export async function requeueScan(db: Db, queueId: string, reason: string): Promise<void> {
  const redis = getRedisClient();

  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(scanQueue)
      .where(eq(scanQueue.id, queueId))
      .for('update')
      .limit(1);

    if (!item) return;

    // Only requeue items that are currently processing
    if (item.status !== 'processing') return;

    // Release proxy resource (session was already deleted by invalidateSession)
    if (item.assignedProxyId) {
      await tx
        .update(proxies)
        .set({ currentUsage: sql`GREATEST(${proxies.currentUsage} - 1, 0)` })
        .where(eq(proxies.id, item.assignedProxyId));
    }
    if (item.assignedSessionId) {
      await tx
        .update(sessions)
        .set({ currentUsage: sql`GREATEST(${sessions.currentUsage} - 1, 0)` })
        .where(eq(sessions.id, item.assignedSessionId));
    }

    // Clear agent's currentQueueId and set status to idle
    if (item.assignedAgentId) {
      await tx
        .update(agents)
        .set({ currentQueueId: null, status: 'idle' })
        .where(eq(agents.id, item.assignedAgentId));
    }

    // Reset the queue item to pending - increment retryCount to track requeue history
    await tx
      .update(scanQueue)
      .set({
        status: 'pending',
        assignedAgentId: null,
        assignedProxyId: null,
        assignedSessionId: null,
        startedAt: null,
        errorMessage: reason,
        retryCount: sql`${scanQueue.retryCount} + 1`,
      })
      .where(eq(scanQueue.id, queueId));

    // Update Redis: remove from processing, add back to pending
    if (redis && redis.status === 'ready') {
      const storedJson = JSON.stringify({
        id: item.id,
        serverAddress: item.serverAddress,
        resolvedIp: item.resolvedIp,
        port: item.port,
        hostname: item.hostname,
      });
      await safeRedisCommand(async (client) => {
        const pipeline = client.pipeline();
        pipeline.del(REDIS_KEYS.QUEUE_ITEM(queueId));
        pipeline.lrem(REDIS_KEYS.QUEUE_PROCESSING, 1, storedJson);
        pipeline.rpush(REDIS_KEYS.QUEUE_PENDING, storedJson);
        await pipeline.exec();
      });
    }
  });

  logger.info(`[RedisQueueService] Requeued task ${queueId}: ${reason}`);
}

/**
 * Get list of all servers with pagination
 */
export async function listServers(db: Db, options: { limit?: number; offset?: number; excludeColumns?: Set<string> } = {}): Promise<typeof servers.$inferSelect[]> {
  const { limit = 100, offset = 0, excludeColumns } = options;
  const columns = excludeColumns ? buildSelectColumns(excludeColumns) : undefined;
  const query = columns ? db.select(columns).from(servers) : db.select().from(servers);
  return (query as any)
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
  return setInterval(async () => {
    try {
      await recoverStuckTasks(db);
      await reconcileResourceUsage(db);
    } catch (err) {
      logger.error('[StuckTaskRecovery] Unhandled error:', err);
    }
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
