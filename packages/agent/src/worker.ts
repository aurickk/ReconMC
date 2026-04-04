import { runFullScan, type FullScanResult } from './scanner.js';
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
 * Requeue a task back to the coordinator's pending queue.
 * Used when all auth sessions are exhausted -- the task should wait
 * for new sessions instead of being marked as failed.
 */
async function requeueTask(base: string, queueId: string, reason: string): Promise<boolean> {
  const res = await fetchWithRetry(
    `${base}/api/queue/${queueId}/requeue`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
    `requeueTask(${queueId})`
  );
  if (!res) {
    logger.error(`[Agent] Failed to requeue task ${queueId} after ${MAX_RETRIES} attempts`);
    return false;
  }
  return true;
}

/**
 * Invalidate a session by reporting it to the coordinator.
 * Returns whether a replacement session is available for retry.
 */
async function invalidateSession(base: string, sessionId: string): Promise<{ deleted: boolean; retryWith: CoordinatorSession | null }> {
  const res = await fetchWithRetry(
    `${base}/api/sessions/${sessionId}/invalidate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
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

/**
 * Check if a scan result's connection error indicates an auth failure.
 * This checks the structured error object in fullResult.connection.error,
 * which is different from the thrown error checked by isAuthFailure().
 */
function isConnectionAuthFailure(connError: Record<string, unknown>): boolean {
  if (connError.code === 'AUTH_FAILED' || connError.code === 'TOKEN_INVALID') {
    return true;
  }
  if (connError.kicked && connError.kickReason &&
      typeof connError.kickReason === 'string') {
    const reason = connError.kickReason.toLowerCase();
    if (reason.includes('invalid session') ||
        reason.includes('failed to login') ||
        reason.includes('multiplayer.disconnect')) {
      return true;
    }
  }
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

    // Shared ref to capture partial results even if timeout fires.
    // runFullScan populates ping data first, then bot connection data.
    // If the global timeout fires during the bot phase, we still have ping data.
    // Using a wrapper object so TypeScript doesn't narrow the inner value
    // based on control flow (the callback mutates .value asynchronously).
    const partialRef: { value: FullScanResult | null } = { value: null };

    // Flag: set to true when all auth sessions are exhausted and the task
    // should be requeued instead of completed/failed.
    let sessionsExhausted = false;

    try {
      const { account: acc, sessionId: initialSessionId } = buildSession(session);
      let sessionId = initialSessionId;
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
          runFullScan(
            {
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
            },
            // Capture ping data as soon as it's available, before the bot
            // phase starts.  If the global timeout fires during bot join,
            // partialResult will already contain the successful ping data.
            (partial) => { partialRef.value = partial; },
          ),
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
            const { account: retryAcc, sessionId: retrySessionId } = buildSession(invalidation.retryWith);
            sessionId = retrySessionId;

            // Single retry with new session
            const retryTimeoutPromise = new Promise<never>((_, reject) => {
              scanTimeoutHandle = setTimeout(() => {
                reject(new Error(`Scan retry timed out after ${scanTimeoutMs}ms`));
              }, scanTimeoutMs);
            });

            try {
              fullResult = await Promise.race([
                runFullScan(
                  {
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
                  },
                  (partial) => { partialRef.value = partial; },
                ),
                retryTimeoutPromise,
              ]);
            } catch (retryError) {
              // If the retry also fails with auth error, invalidate the replacement session
              if (isAuthFailure(retryError)) {
                logger.warn(`[Task] ${queueId} - Retry also threw auth failure, invalidating replacement session`);
                const retryInvalidation = await invalidateSession(base, retrySessionId);
                // If no more sessions after invalidating the retry session, requeue
                if (!retryInvalidation.retryWith) {
                  sessionsExhausted = true;
                }
              }
              throw retryError;
            }
          } else {
            // No replacement session available -- requeue instead of failing
            sessionsExhausted = true;
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
        if (isConnectionAuthFailure(connError)) {
          logger.warn(`[Task] ${queueId} - Scan completed but auth failure detected in result, invalidating session`);
          const invalidation = await invalidateSession(base, sessionId);

          // Retry the scan with a replacement session if available.
          // We already have ping data, but re-running the full scan is simpler
          // than trying to retry just the bot connection portion.
          if (invalidation.retryWith) {
            logger.info(`[Task] ${queueId} - Retrying scan with replacement session`);
            const { account: retryAcc, sessionId: retrySessionId } = buildSession(invalidation.retryWith);
            sessionId = retrySessionId;
            const remainingMs = scanTimeoutMs - (Date.now() - taskStartTime);

            if (remainingMs > 5000) {
              const retryTimeoutPromise = new Promise<never>((_, reject) => {
                scanTimeoutHandle = setTimeout(() => {
                  reject(new Error(`Scan retry timed out after ${remainingMs}ms`));
                }, remainingMs);
              });

              try {
                fullResult = await Promise.race([
                  runFullScan(
                    {
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
                    },
                    (partial) => { partialRef.value = partial; },
                  ),
                  retryTimeoutPromise,
                ]);

                if (scanTimeoutHandle) {
                  clearTimeout(scanTimeoutHandle);
                  scanTimeoutHandle = null;
                }

                // Check if the retry result also has an auth failure -- if so,
                // invalidate the replacement session too so it doesn't poison future scans
                if (fullResult.connection && !fullResult.connection.success && fullResult.connection.error) {
                  if (isConnectionAuthFailure(fullResult.connection.error)) {
                    logger.warn(`[Task] ${queueId} - Retry also produced auth failure, invalidating replacement session`);
                    const retryInvalidation = await invalidateSession(base, retrySessionId);
                    // If no more sessions after the retry also failed, requeue
                    if (!retryInvalidation.retryWith) {
                      sessionsExhausted = true;
                    }
                  }
                }
              } catch (retryError) {
                if (scanTimeoutHandle) {
                  clearTimeout(scanTimeoutHandle);
                  scanTimeoutHandle = null;
                }
                // If the retry threw an auth failure, invalidate the replacement session
                if (isAuthFailure(retryError)) {
                  logger.warn(`[Task] ${queueId} - Retry threw auth failure, invalidating replacement session`);
                  const retryInvalidation = await invalidateSession(base, retrySessionId);
                  if (!retryInvalidation.retryWith) {
                    sessionsExhausted = true;
                  }
                }
                logger.warn(`[Task] ${queueId} - Retry with replacement session failed`);
                // Fall through with the original result (ping data preserved)
              }
            } else {
              logger.warn(`[Task] ${queueId} - Not enough time remaining for retry (${remainingMs}ms)`);
            }
          } else {
            // No replacement session available -- requeue instead of completing with failed auth
            sessionsExhausted = true;
          }
        }
      }

      // If sessions are exhausted, requeue instead of completing with a failed connection result
      if (sessionsExhausted) {
        logger.info(`[Task] ${queueId} - All sessions exhausted, requeueing task to wait for new sessions`);
        await clearTaskContext();
        const requeued = await requeueTask(base, queueId, 'All auth sessions exhausted - waiting for new sessions');
        if (!requeued) {
          // Fallback: if requeue fails, complete with whatever partial data we have
          logger.warn(`[Task] ${queueId} - Requeue failed, completing with partial result`);
          await completeTask(base, queueId, fullResult);
        }
      } else {
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
      }
    } catch (err) {
      if (scanTimeoutHandle) {
        clearTimeout(scanTimeoutHandle);
      }
      const scanTime = Date.now() - taskStartTime;

      // If sessions are exhausted, requeue the task instead of failing it
      if (sessionsExhausted) {
        logger.info(`[Task] ${queueId} - All sessions exhausted (error path), requeueing task to wait for new sessions`);
        await clearTaskContext();
        const requeued = await requeueTask(base, queueId, 'All auth sessions exhausted - waiting for new sessions');
        if (requeued) {
          // Successfully requeued, skip the fail/complete logic below
        } else {
          // Fallback: if requeue fails, report as failed
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[Task] ${queueId} - Requeue failed, marking as failed: ${message}`);
          await failTask(base, queueId, message);
        }
      } else {
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

        // If we have partial results (e.g. ping succeeded but bot join timed out),
        // report as completed with partial data rather than a total failure.
        // This preserves ping/status data even when the bot phase fails.
        const captured = partialRef.value;
        if (captured && captured.ping?.success) {
          logger.warn(`[Task] ${queueId} - PARTIAL: ${message}${details} (Time: ${scanTime}ms) - preserving ping data`);
          await clearTaskContext();
          await completeTask(base, queueId, captured);
        } else {
          logger.error(`[Task] ${queueId} - FAILED: ${message}${details} (Time: ${scanTime}ms)`);
          // Flush logs before failing the task
          await clearTaskContext();
          await failTask(base, queueId, message);
        }
      }
    }

    await heartbeat(base, 'idle');
    lastHeartbeat = Date.now();
  }

  logger.info('[Agent] Shutting down');
}
