import { eq, and, or, sql, desc, asc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { scanQueue, servers, agents } from '../db/schema.js';
import type { NewScanQueue, Server, ScanQueue } from '../db/schema.js';
import { resolveServerIp, PrivateIpError, parseServerAddress } from './ipResolver.js';
import { allocateResourcesTx } from './resourceAllocator.js';

export interface AddToQueueInput {
  servers: string[];
}

export interface AddToQueueResult {
  added: number;
  skipped: number;
  queued: Array<{ id: string; serverAddress: string; resolvedIp: string; port: number }>;
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
 * Add servers to the scan queue with duplicate filtering
 */
export async function addToQueue(db: Db, input: AddToQueueInput): Promise<AddToQueueResult> {
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

  // Deduplicate by resolvedIp + port + hostname within this batch
  const seenKeys = new Set<string>();
  const uniqueResolved: typeof resolved = [];
  for (const r of resolved) {
    if (!r || !r.address) continue;
    const key = `${r.resolvedIp}:${r.port}:${r.hostname ?? ''}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueResolved.push(r);
  }

  // Get existing entries in scan_queue (pending or processing)
  const existingQueue = await db
    .select({ resolvedIp: scanQueue.resolvedIp, port: scanQueue.port, hostname: scanQueue.hostname })
    .from(scanQueue)
    .where(or(eq(scanQueue.status, 'pending'), eq(scanQueue.status, 'processing')));

  const queueKeys = new Set(
    existingQueue.map((r) => `${r.resolvedIp}:${r.port}:${r.hostname ?? ''}`)
  );

  const added: Array<{ id: string; serverAddress: string; resolvedIp: string; port: number }> = [];
  let skipped = 0;

  for (const r of uniqueResolved) {
    if (!r) continue;
    const key = `${r.resolvedIp}:${r.port}:${r.hostname ?? ''}`;
    if (queueKeys.has(key)) {
      skipped++;
      continue;
    }

    const [inserted] = await db
      .insert(scanQueue)
      .values({
        serverAddress: r.address,
        hostname: r.hostname,
        resolvedIp: r.resolvedIp,
        port: r.port,
        status: 'pending',
      } as NewScanQueue)
      .returning();

    if (inserted) {
      added.push({
        id: inserted.id,
        serverAddress: inserted.serverAddress,
        resolvedIp: inserted.resolvedIp ?? '',
        port: inserted.port,
      });
    }
  }

  return { added: added.length, skipped, queued: added };
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

/**
 * Claim next available server from the queue with resource allocation
 */
export async function claimFromQueue(db: Db, agentId: string): Promise<ClaimedQueueItem | null> {
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

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalServers: number;
}

/**
 * Get current queue status statistics
 */
export async function getQueueStatus(db: Db): Promise<QueueStatus> {
  const pending = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanQueue)
    .where(eq(scanQueue.status, 'pending'));

  const processing = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanQueue)
    .where(eq(scanQueue.status, 'processing'));

  const completed = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanQueue)
    .where(eq(scanQueue.status, 'completed'));

  const failed = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanQueue)
    .where(eq(scanQueue.status, 'failed'));

  const totalServers = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(servers);

  return {
    pending: pending[0]?.count ?? 0,
    processing: processing[0]?.count ?? 0,
    completed: completed[0]?.count ?? 0,
    failed: failed[0]?.count ?? 0,
    totalServers: totalServers[0]?.count ?? 0,
  };
}

export interface QueueEntryOptions {
  limit?: number;
  offset?: number;
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'all';
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
export interface ServerListOptions {
  limit?: number;
  offset?: number;
}

/**
 * Get list of all servers with pagination
 */
export async function listServers(db: Db, options: ServerListOptions = {}): Promise<Server[]> {
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
export async function getServer(db: Db, serverId: string): Promise<Server | null> {
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
