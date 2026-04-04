/**
 * Full scan: ping server then connect bot with plugin detection.
 * Mirrors the API /scan/full flow for use by the agent.
 */
import { scanServer, isNativelySupported, getNativeVersion, MAX_NATIVE_PROTOCOL, PROTOCOL_VERSIONS } from '@reconmc/scanner';
import { connectBot } from '@reconmc/bot';
import type { Account } from '@reconmc/bot';
import type { ScanResult, IpLocation, ProxyConfig } from '@reconmc/scanner';
import { logger } from './logger.js';

export interface FullScanResult {
  ping: ScanResult;
  connection?: {
    success: boolean;
    host: string;
    port: number;
    username: string;
    uuid?: string;
    connectedAt?: string;
    disconnectedAt?: string;
    spawnPosition?: { x: number; y: number; z: number };
    error?: { code: string; message: string; kicked?: boolean; kickReason?: string };
    attempts: number;
    latency?: number;
    accountType?: 'cracked' | 'microsoft';
    serverPlugins?: { plugins: string[]; method: string };
    serverCommands?: { commands: string[]; method: string };
    serverAuth?: { authRequired: boolean; authType?: string; success: boolean; error?: string };
    serverGameModes?: { gameModes: string[]; command: string; totalCandidates: number; isGuiOnly: boolean };
  };
  serverMode?: 'unknown' | 'cracked' | 'online';
}

export interface FullScanInput {
  host: string;
  port: number;
  proxy: ProxyConfig;
  account: Account;
  fallbackAccount?: Account;
  collectPlugins?: boolean;
  pluginTimeout?: number;
  enableAutoAuth?: boolean;
  authTimeout?: number;
}

/**
 * Redact sensitive information from strings
 */
function redactProxy(str: string): string {
  return str.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'xxx.xxx.xxx.xxx');
}

/**
 * Format server status data for logging (redacts favicon image data)
 */
function formatServerStatus(status: any): string {
  if (!status) return '{}';

  const clean: any = {};
  if (status.version) clean.version = status.version;
  if (status.players) clean.players = {
    online: status.players.online,
    max: status.players.max,
  };
  if (status.description) {
    const desc = status.description;
    clean.description = typeof desc === 'string'
      ? desc.replace(/§./g, '').substring(0, 100)
      : (desc.text || '').replace(/§./g, '').substring(0, 100);
  }
  clean.hasIcon = !!status.favicon;
  if (status.modinfo) clean.modinfo = `${status.modinfo.type} (${status.modinfo.modList?.length || 0} mods)`;
  return JSON.stringify(clean).substring(0, 500);
}

/**
 * Lookup geolocation for an IP address using a free API
 */
async function lookupIpLocation(ip: string): Promise<IpLocation | null> {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}`, {
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });
    if (response.status !== 200) {
      return null;
    }
    const data = await response.json() as {
      country?: string;
      countryCode?: string;
      city?: string;
      isp?: string;
      lat?: number;
      lon?: number;
      status?: string;
    };
    if (data.status === 'fail') {
      return null;
    }
    // ip-api.com returns:
    //   "country"     = full name (e.g., "United States")
    //   "countryCode" = 2-letter ISO code (e.g., "US")
    return {
      country: data.countryCode,  // 2-letter country code (e.g., "US")
      countryName: data.country,  // Full country name (e.g., "United States")
      city: data.city,
      isp: data.isp,
      lat: data.lat,
      lon: data.lon,
    };
  } catch {
    return null;
  }
}

/**
 * Run full scan: ping then bot connection with plugin detection.
 *
 * @param input - Scan configuration
 * @param onPingComplete - Optional callback invoked after the ping phase succeeds,
 *   before the bot join phase starts.  Receives the partial FullScanResult
 *   containing ping data.  Useful for capturing partial results if the bot
 *   phase is later interrupted by an external timeout.
 */
export async function runFullScan(
  input: FullScanInput,
  onPingComplete?: (partial: FullScanResult) => void,
): Promise<FullScanResult> {
  const scanStartTime = Date.now();

  const proxy = {
    host: input.proxy.host,
    port: input.proxy.port,
    type: input.proxy.type,
    username: input.proxy.username,
    password: input.proxy.password,
  };

  // Log ping start (redacted proxy info)
  logger.info(`[Ping] Pinging ${input.host}:${input.port} via ${input.proxy.type} (proxy redacted)`);

  const pingResult = await scanServer({
    host: input.host,
    port: input.port,
    timeout: 5000,
    retries: 2,
    retryDelay: 1000,
    proxy,
    enableServerModeDetection: true,
  });

  const result: FullScanResult = { ping: pingResult };

  // Log ping result with full status
  if (pingResult.success) {
    const latency = pingResult.status?.latency;
    const latencyStr = typeof latency === 'number' ? `${latency}ms` : 'N/A';
    logger.info(`[Ping] Success: ${latencyStr} latency | IP: ${pingResult.resolvedIp || input.host}`);
    logger.info(`[Status] ${formatServerStatus(pingResult.status?.data)}`);
  } else {
    logger.warn(`[Ping] Failed: ${pingResult.error || 'Unknown error'}`);
    return result;
  }

  // Lookup IP geolocation if we have a resolved IP
  if (pingResult.resolvedIp) {
    const location = await lookupIpLocation(pingResult.resolvedIp);
    if (location) {
      pingResult.location = location;
      const locationStr = location.countryName
        ? `${location.countryName}${location.city ? `, ${location.city}` : ''}`
        : location.country || 'Unknown';
      logger.info(`[Geo] IP location: ${locationStr} (${pingResult.resolvedIp})`);
    }
  }

  // Server mode is already detected by scanServer when enableServerModeDetection: true
  // No need to re-detect here - use the value from pingResult.serverMode
  const serverMode: 'unknown' | 'cracked' | 'online' = pingResult.serverMode ?? 'unknown';
  result.serverMode = serverMode;
  logger.info(`[Mode] Server mode: ${serverMode}`);

  // Notify caller that ping phase is complete -- allows capturing partial
  // results for timeout resilience (ping data survives even if bot phase
  // is killed by the global task timeout).
  if (onPingComplete) {
    onPingComplete({ ...result });
  }

  if (serverMode === 'online' && input.account.type !== 'microsoft') {
    logger.warn(`[Mode] Account mismatch: Server requires online-mode authentication`);
    result.connection = {
      success: false,
      host: input.host,
      port: input.port,
      username: 'redacted',
      attempts: 0,
      error: { code: 'ACCOUNT_MISMATCH', message: 'Server is online mode but account is not Microsoft' },
    };
    return result;
  }

  const collectPlugins = input.collectPlugins !== false;

  // Determine connection strategy based on server protocol version.
  // mineflayer supports 1.7 through 1.21.11 (protocol 774).
  // For servers reporting a supported protocol, connect with the matching version.
  // For unsupported protocols (>774), try the highest native version directly
  // (many servers accept older clients via ViaVersion).
  const serverProtocol = pingResult.status?.data?.version?.protocol;
  const serverVersion = pingResult.status?.data?.version?.name || 'unknown';
  const highestNativeVersion = PROTOCOL_VERSIONS[MAX_NATIVE_PROTOCOL]; // '1.21.11'

  const nativeVersion = serverProtocol != null ? getNativeVersion(serverProtocol) : null;
  const needsVersionFallback = serverProtocol != null && !isNativelySupported(serverProtocol);

  if (nativeVersion) {
    logger.info(`[Protocol] Server ${serverVersion} (protocol ${serverProtocol}) → connecting with ${nativeVersion}`);
  } else if (needsVersionFallback) {
    logger.info(`[Protocol] Server ${serverVersion} (protocol ${serverProtocol}) exceeds native support (max ${highestNativeVersion}) — trying ${highestNativeVersion}`);
  }

  // Version to connect with:
  // - Natively supported protocol → exact matching version
  // - Protocol exceeds support → highest native version (server may accept via ViaVersion)
  // - Unknown protocol → let mineflayer auto-detect (no version override)
  const connectVersion = nativeVersion || (needsVersionFallback ? highestNativeVersion : undefined);

  const connectResult = await connectBot(
    {
      account: input.account,
      fallbackAccount: input.fallbackAccount,
      collectPlugins,
      pluginTimeout: input.pluginTimeout ?? 5000,
      enableAutoAuth: input.enableAutoAuth ?? true,
      authTimeout: input.authTimeout ?? 3000,
      host: input.host,
      port: input.port,
      proxy,
      timeout: 20000,
      retries: 1,
      retryDelay: 2000,
      ...(connectVersion && { version: connectVersion }),
    },
    serverMode
  );

  // Log connection result
  if (connectResult.success) {
    logger.info(`[Bot] Connected successfully`);
    if (connectResult.latency) {
      logger.info(`[Bot] Connection latency: ${connectResult.latency}ms`);
    }
    if (connectResult.spawnPosition) {
      logger.info(`[Bot] Spawn: ${connectResult.spawnPosition.x}, ${connectResult.spawnPosition.y}, ${connectResult.spawnPosition.z}`);
    }
    if (connectResult.serverAuth) {
      const authStatus = connectResult.serverAuth.success ? 'Success' : 'Failed';
      const authType = connectResult.serverAuth.authType || 'None';
      const authRequired = connectResult.serverAuth.authRequired ? 'Required' : 'Not required';
      logger.info(`[Auth] Server authentication: ${authStatus} | Type: ${authType} | ${authRequired}`);
    }
    if (connectResult.serverPlugins?.plugins) {
      const count = connectResult.serverPlugins.plugins.length;
      const method = connectResult.serverPlugins.method || 'unknown';
      logger.info(`[Plugins] Detected ${count} plugins (method: ${method})`);
    }
    if (connectResult.serverCommands?.commands) {
      const count = connectResult.serverCommands.commands.length;
      const method = connectResult.serverCommands.method || 'unknown';
      logger.info(`[Commands] Detected ${count} commands (method: ${method})`);
    }
    if (connectResult.serverGameModes?.gameModes && connectResult.serverGameModes.gameModes.length > 0) {
      const count = connectResult.serverGameModes.gameModes.length;
      const cmd = connectResult.serverGameModes.command || 'unknown';
      const modes = connectResult.serverGameModes.gameModes.slice(0, 10).join(', ');
      const truncated = count > 10 ? ` (showing first 10 of ${count})` : '';
      logger.info(`[GameModes] Detected ${count} game modes via /${cmd}: ${modes}${truncated}`);
    }
  } else {
    const errorMsg = connectResult.error?.message || 'Unknown error';
    const errorCode = connectResult.error?.code || 'UNKNOWN';
    const wasKicked = connectResult.error?.kicked ? ' (kicked)' : '';
    const kickReason = connectResult.error?.kickReason || '';
    // Always include error message alongside code for actionable diagnostics
    const errorDetail = kickReason
      ? redactProxy(kickReason)
      : (errorMsg !== errorCode ? redactProxy(errorMsg) : '');
    logger.warn(`[Bot] Connection failed: ${errorCode}${wasKicked}${errorDetail ? ` - ${errorDetail}` : ''} (${connectResult.attempts} attempts)`);
  }

  result.connection = {
    success: connectResult.success,
    host: connectResult.host,
    port: connectResult.port,
    username: 'redacted',
    uuid: connectResult.uuid,
    connectedAt: connectResult.connectedAt?.toISOString(),
    disconnectedAt: connectResult.disconnectedAt?.toISOString(),
    spawnPosition: connectResult.spawnPosition,
    error: connectResult.error,
    attempts: connectResult.attempts,
    latency: connectResult.latency,
    accountType: connectResult.accountType,
    serverPlugins: connectResult.serverPlugins,
    serverCommands: connectResult.serverCommands,
    serverAuth: connectResult.serverAuth,
    serverGameModes: connectResult.serverGameModes,
  };

  const scanTime = Date.now() - scanStartTime;
  logger.info(`[Task] Scan completed in ${scanTime}ms`);

  return result;
}
