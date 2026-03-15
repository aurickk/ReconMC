import { runFullScan } from './scanner.js';
import { setTaskContext, clearTaskContext, interceptConsole, logger } from './logger.js';
import { AGENT_ID, COORDINATOR_URL } from './config.js';
import type { Account } from '@reconmc/bot';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function getCoordinatorBase(): string {
  return COORDINATOR_URL.replace(/\/$/, '');
}

interface CoordinatorSession {
  id: string;
  username?: string;
  accessToken?: string;
  // no type, no refreshToken -- sessions are disposable
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  operation: string
): Promise<Response | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      const body = await res.text().catch(() => '');
      logger.warn(`[Agent] ${operation} attempt ${attempt}/${MAX_RETRIES} failed: HTTP ${res.status} - ${body}`);
    } catch (err) {
      logger.warn(`[Agent] ${operation} attempt ${attempt}/${MAX_RETRIES} network error: ${err}`);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  return null;
}

function buildSession(session: CoordinatorSession): { account: Account; sessionId: string } {
  if (!session.accessToken) throw new Error('Session missing accessToken');
  return {
    account: {
      type: 'microsoft',
      accessToken: session.accessToken,
      // no refreshToken -- sessions are disposable
    },
    sessionId: session.id,
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
  session: CoordinatorSession;
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
    session: CoordinatorSession;
  };
  return data;
}

async function completeTask(base: string, queueId: string, result: unknown): Promise<void> {
  const res = await fetchWithRetry(
    `${base}/api/queue/${queueId}/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    },
    `completeTask(${queueId})`
  );
  if (!res) {
    throw new Error(`Failed to complete task ${queueId} after ${MAX_RETRIES} attempts`);
  }
}

async function failTask(base: string, queueId: string, errorMessage: string): Promise<void> {
  const res = await fetchWithRetry(
    `${base}/api/queue/${queueId}/fail`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorMessage }),
    },
    `failTask(${queueId})`
  );
  if (!res) {
    logger.error(`[Agent] CRITICAL: Failed to report task ${queueId} as failed after ${MAX_RETRIES} attempts. Task may be stuck in processing.`);
  }
}

/**
 * Invalidate a session by reporting it to the coordinator.
 * Returns whether a replacement session is available for retry.
 */
async function invalidateSession(base: string, sessionId: string): Promise<{ deleted: boolean; retryWith: CoordinatorSession | null }> {
  const res = await fetchWithRetry(
    `${base}/api/sessions/${sessionId}/invalidate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    'invalidate-session'
  );
  if (!res) return { deleted: false, retryWith: null };
  const body = await res.json() as { deleted: boolean; retryWith: CoordinatorSession | null };
  return body;
}

/**
 * Check if a scan error indicates an authentication failure.
 * Only auth-specific errors should trigger session invalidation --
 * NOT network errors, timeouts, or server-side issues.
 */
function isAuthFailure(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Auth-specific kick reasons
  if (lowerMessage.includes('invalid session') ||
      lowerMessage.includes('failed to login') ||
      lowerMessage.includes('multiplayer.disconnect') ||
      lowerMessage.includes('authentication failed') ||
      lowerMessage.includes('microsoft authentication failed')) {
    return true;
  }

  // Check for error object with code
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>;
    const code = typeof errorObj.code === 'string' ? errorObj.code : '';
    if (code === 'AUTH_FAILED' || code === 'TOKEN_INVALID') {
      return true;
    }
    // Check kick reason for auth indicators
    if (typeof errorObj.kickReason === 'string') {
      const reason = errorObj.kickReason.toLowerCase();
      if (reason.includes('invalid session') ||
          reason.includes('failed to login') ||
          reason.includes('multiplayer.disconnect') ||
          reason.includes('not authenticated')) {
        return true;
      }
    }
  }

  // Do NOT treat these as auth failures:
  // - ECONNREFUSED, ETIMEDOUT, ECONNRESET (network errors)
  // - KICKED_WHITELIST, KICKED_BANNED, KICKED_FULL (server policy)
  // - PROXY_ERROR (proxy issues)
  return false;
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
    const { queueId, serverAddress, port, proxy, session } = claimed;

    // Set logging context for this task
    setTaskContext(queueId);

    // Log task assignment details (sensitive info redacted)
    const displayServer = serverAddress.includes(':') ? serverAddress : `${serverAddress}:${port}`;
    logger.info(`[Task] ${queueId} - Received task for ${displayServer}`);
    logger.info(`[Task] ${queueId} - Proxy: ${proxy.type} (IP redacted)`);
    logger.info(`[Task] ${queueId} - Session: microsoft (token redacted)`);

    // Add overall timeout for the entire scan (60 seconds max per task)
    const scanTimeoutMs = 60000;
    let scanTimeoutHandle: NodeJS.Timeout | null = null;
    const taskStartTime = Date.now();

    try {
      const { account: acc, sessionId } = buildSession(session);
      const host = serverAddress.includes(':') ? serverAddress.split(':')[0]! : serverAddress;

      // Set up timeout to fail the scan if it takes too long
      const timeoutPromise = new Promise<never>((_, reject) => {
        scanTimeoutHandle = setTimeout(() => {
          reject(new Error(`Scan timed out after ${scanTimeoutMs}ms`));
        }, scanTimeoutMs);
      });

      let fullResult;
      try {
        fullResult = await Promise.race([
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
      } catch (scanError) {
        if (scanTimeoutHandle) {
          clearTimeout(scanTimeoutHandle);
          scanTimeoutHandle = null;
        }

        // Check if this is an auth failure -- if so, invalidate session and retry once
        if (isAuthFailure(scanError)) {
          logger.warn(`[Task] ${queueId} - Auth failure detected, invalidating session`);
          const invalidation = await invalidateSession(base, sessionId);

          if (invalidation.retryWith) {
            logger.info(`[Task] ${queueId} - Retrying with replacement session`);
            const { account: retryAcc } = buildSession(invalidation.retryWith);

            // Single retry with new session
            const retryTimeoutPromise = new Promise<never>((_, reject) => {
              scanTimeoutHandle = setTimeout(() => {
                reject(new Error(`Scan retry timed out after ${scanTimeoutMs}ms`));
              }, scanTimeoutMs);
            });

            fullResult = await Promise.race([
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
                account: retryAcc,
                collectPlugins: true,
                pluginTimeout: 5000,
                enableAutoAuth: true,
                authTimeout: 3000,
              }),
              retryTimeoutPromise,
            ]);
          } else {
            // No replacement session available
            throw new Error('Auth failure and no available sessions for retry');
          }
        } else {
          // Not an auth failure -- rethrow
          throw scanError;
        }
      }

      if (scanTimeoutHandle) {
        clearTimeout(scanTimeoutHandle);
        scanTimeoutHandle = null;
      }

      // Check if the scan result itself indicates an auth failure (e.g. kicked for invalid session)
      if (fullResult.connection && !fullResult.connection.success && fullResult.connection.error) {
        const connError = fullResult.connection.error;
        if (connError.code === 'AUTH_FAILED' || connError.code === 'TOKEN_INVALID' ||
            (connError.kicked && connError.kickReason &&
             (connError.kickReason.toLowerCase().includes('invalid session') ||
              connError.kickReason.toLowerCase().includes('failed to login') ||
              connError.kickReason.toLowerCase().includes('multiplayer.disconnect')))) {
          logger.warn(`[Task] ${queueId} - Scan completed but auth failure detected in result, invalidating session`);
          await invalidateSession(base, sessionId);
          // Don't retry here -- the scan completed (with ping data), so report the result
        }
      }

      // Log completion summary BEFORE clearing context
      const pingSuccess = fullResult.ping?.success ? 'Y' : 'N';
      const pingLatency = fullResult.ping?.status?.latency ?? 'N/A';
      const pingLatencyStr = typeof pingLatency === 'number' ? `${pingLatency}ms` : String(pingLatency);
      const connSuccess = fullResult.connection?.success ? 'Y' : 'N';
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

    await heartbeat(base, 'idle');
    lastHeartbeat = Date.now();
  }

  logger.info('[Agent] Shutting down');
}
