import { runFullScan } from './scanner.js';
import { setTaskContext, clearTaskContext, interceptConsole, logger } from './logger.js';
import { AGENT_ID, COORDINATOR_URL } from './config.js';
import type { Account } from '@reconmc/bot';
import { setTokenRefreshCallback, clearTokenRefreshCallback } from '@reconmc/bot';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);
const HEARTBEAT_INTERVAL_MS = 30_000;

function getCoordinatorBase(): string {
  return COORDINATOR_URL.replace(/\/$/, '');
}

interface CoordinatorAccount {
  id: string;
  type: string;
  username?: string;
  accessToken?: string;
  refreshToken?: string;
}

function buildAccount(account: CoordinatorAccount): { account: Account; accountId: string } {
  if (account.type === 'microsoft') {
    if (!account.accessToken) throw new Error('Microsoft account missing accessToken');
    return {
      account: {
        type: 'microsoft',
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
      },
      accountId: account.id,
    };
  }
  const username = account.username ?? `Recon${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  return {
    account: { type: 'cracked', username },
    accountId: account.id,
  };
}

async function register(base: string): Promise<boolean> {
  const res = await fetch(`${base}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT_ID }),
  });
  return res.ok;
}

async function heartbeat(base: string, status: string, currentQueueId?: string): Promise<void> {
  try {
    await fetch(`${base}/api/agents/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: AGENT_ID,
        status,
        ...(currentQueueId && { currentQueueId }),
      }),
    });
  } catch {
    // ignore
  }
}

async function claimTask(base: string): Promise<{
  queueId: string;
  serverAddress: string;
  port: number;
  proxy: { host: string; port: number; type: 'socks4' | 'socks5'; username?: string; password?: string };
  account: CoordinatorAccount;
} | null> {
  const res = await fetch(`${base}/api/queue/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT_ID }),
  });
  if (res.status === 204) return null;
  if (!res.ok) return null;
  const data = await res.json() as {
    queueId: string;
    serverAddress: string;
    port: number;
    proxy: { host: string; port: number; type: 'socks4' | 'socks5'; username?: string; password?: string };
    account: CoordinatorAccount;
  };
  return data;
}

async function completeTask(base: string, queueId: string, result: unknown): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${base}/api/queue/${queueId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result }),
      });

      if (res.ok) return;

      const body = await res.text().catch(() => '');
      logger.warn(`[Agent] completeTask attempt ${attempt}/${MAX_RETRIES} failed: HTTP ${res.status} - ${body}`);
    } catch (err) {
      logger.warn(`[Agent] completeTask attempt ${attempt}/${MAX_RETRIES} network error: ${err}`);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }

  // All retries exhausted - throw so the catch block can call failTask
  throw new Error(`Failed to complete task ${queueId} after ${MAX_RETRIES} attempts`);
}

async function failTask(base: string, queueId: string, errorMessage: string): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${base}/api/queue/${queueId}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errorMessage }),
      });

      if (res.ok) return;

      const body = await res.text().catch(() => '');
      logger.warn(`[Agent] failTask attempt ${attempt}/${MAX_RETRIES} failed: HTTP ${res.status} - ${body}`);
    } catch (err) {
      logger.warn(`[Agent] failTask attempt ${attempt}/${MAX_RETRIES} network error: ${err}`);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }

  // All retries exhausted - log critical error (can't do much else)
  logger.error(`[Agent] CRITICAL: Failed to report task ${queueId} as failed after ${MAX_RETRIES} attempts. Task may be stuck in processing.`);
}

/**
 * Report refreshed tokens back to the coordinator
 */
async function reportRefreshedTokens(base: string, accountId: string, tokens: {
  accessToken: string;
  refreshToken?: string;
}): Promise<void> {
  try {
    const res = await fetch(`${base}/api/accounts/${accountId}/tokens`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens),
    });
    if (res.ok) {
      logger.info(`[Agent] Reported refreshed tokens for account (UUID redacted)`);
    } else {
      logger.warn(`[Agent] Failed to report refreshed tokens: HTTP ${res.status}`);
    }
  } catch (err) {
    logger.warn(`[Agent] Failed to report refreshed tokens: ${err}`);
  }
}

export async function runWorker(): Promise<void> {
  const base = getCoordinatorBase();

  const ok = await register(base);
  if (!ok) {
    logger.error('[Agent] Failed to register with coordinator');
    process.exit(1);
  }
  logger.info(`[Agent] Registered as ${AGENT_ID}`);

  // Intercept console to capture all logs
  interceptConsole();

  let lastHeartbeat = Date.now();
  let running = true;

  const shutdown = () => {
    running = false;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      await heartbeat(base, 'idle');
      lastHeartbeat = Date.now();
    }

    const claimed = await claimTask(base);
    if (!claimed) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    await heartbeat(base, 'busy', claimed.queueId);
    const { queueId, serverAddress, port, proxy, account } = claimed;

    // Set logging context for this task
    setTaskContext(queueId);

    // Log task assignment details (sensitive info redacted)
    const displayServer = serverAddress.includes(':') ? serverAddress : `${serverAddress}:${port}`;
    logger.info(`[Task] ${queueId} - Received task for ${displayServer}`);
    logger.info(`[Task] ${queueId} - Proxy: ${proxy.type} (IP redacted)`);
    logger.info(`[Task] ${queueId} - Account type: ${account.type}${account.type === 'microsoft' ? ' (Microsoft authentication)' : ''}`);

    // Add overall timeout for the entire scan (60 seconds max per task)
    const scanTimeoutMs = 60000;
    let scanTimeoutHandle: NodeJS.Timeout | null = null;
    const taskStartTime = Date.now();

    try {
      const { account: acc, accountId } = buildAccount(account);
      const host = serverAddress.includes(':') ? serverAddress.split(':')[0]! : serverAddress;

      // Set up token refresh callback for Microsoft accounts
      if (acc.type === 'microsoft') {
        // Clear any previous callback before setting a new one
        clearTokenRefreshCallback();
        setTokenRefreshCallback(accountId, (id: string, tokens: { accessToken: string; refreshToken?: string }) => {
          return reportRefreshedTokens(base, id, tokens);
        });
      }

      // Set up timeout to fail the scan if it takes too long
      const timeoutPromise = new Promise<never>((_, reject) => {
        scanTimeoutHandle = setTimeout(() => {
          reject(new Error(`Scan timed out after ${scanTimeoutMs}ms`));
        }, scanTimeoutMs);
      });

      const fullResult = await Promise.race([
        runFullScan({
          host,
          port,
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: proxy.type,
            username: proxy.username,
            password: proxy.password,
          },
          account: acc,
          collectPlugins: true,
          pluginTimeout: 5000,
          enableAutoAuth: true,
          authTimeout: 3000,
        }),
        timeoutPromise,
      ]);

      if (scanTimeoutHandle) {
        clearTimeout(scanTimeoutHandle);
        scanTimeoutHandle = null;
      }

      // Log completion summary BEFORE clearing context
      const pingSuccess = fullResult.ping?.success ? '✓' : '✗';
      const pingLatency = fullResult.ping?.status?.latency ?? 'N/A';
      const pingLatencyStr = typeof pingLatency === 'number' ? `${pingLatency}ms` : String(pingLatency);
      const connSuccess = fullResult.connection?.success ? '✓' : '✗';
      const connLatency = fullResult.connection?.latency;
      const connLatencyStr = connLatency ? `${connLatency}ms` : 'N/A';
      const plugins = fullResult.connection?.serverPlugins?.plugins?.length || 0;
      const serverMode = fullResult.serverMode || 'unknown';
      const scanTime = Date.now() - taskStartTime;

      logger.info(`[Task] ${queueId} - COMPLETED: Ping ${pingSuccess} (${pingLatencyStr}), Connect ${connSuccess} (${connLatencyStr}), Mode: ${serverMode}, Plugins: ${plugins}, Time: ${scanTime}ms`);

      // Flush any pending logs before completing the task
      await clearTaskContext();
      await completeTask(base, queueId, fullResult);
    } catch (err) {
      if (scanTimeoutHandle) {
        clearTimeout(scanTimeoutHandle);
      }
      const scanTime = Date.now() - taskStartTime;

      // Extract detailed error info
      let message = err instanceof Error ? err.message : String(err);
      let details = '';

      // Check for error object with additional details
      if (err && typeof err === 'object') {
        const errorObj = err as Record<string, unknown>;
        if (errorObj.code && typeof errorObj.code === 'string') {
          details = ` [${errorObj.code}]`;
        }
        if (errorObj.kickReason && typeof errorObj.kickReason === 'string') {
          details += ` - ${errorObj.kickReason}`;
        }
      }

      logger.error(`[Task] ${queueId} - FAILED: ${message}${details} (Time: ${scanTime}ms)`);
      // Flush logs before failing the task
      await clearTaskContext();
      await failTask(base, queueId, message);
    }
    // Note: Token refresh callback persists across tasks for the same account
    // It's only cleared when a different account is assigned or agent shuts down

    await heartbeat(base, 'idle');
    lastHeartbeat = Date.now();
  }

  logger.info('[Agent] Shutting down');
}
