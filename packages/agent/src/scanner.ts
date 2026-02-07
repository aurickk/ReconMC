/**
 * Full scan: ping server then connect bot with plugin detection.
 * Mirrors the API /scan/full flow for use by the agent.
 */
import { scanServer, detectServerMode } from '@reconmc/scanner';
import { connectBot } from '@reconmc/bot';
import type { Account } from '@reconmc/bot';
import type { ScanResult, IpLocation } from '@reconmc/scanner';
import { logger } from './logger.js';

export interface ProxyConfig {
  host: string;
  port: number;
  type: 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

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
    serverAuth?: { authRequired: boolean; authType?: string; success: boolean; error?: string };
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
      countryName?: string;
      city?: string;
      isp?: string;
      lat?: number;
      lon?: number;
      status?: string;
    };
    if (data.status === 'fail') {
      return null;
    }
    return {
      country: data.country,
      countryName: data.countryName,
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
 */
export async function runFullScan(input: FullScanInput): Promise<FullScanResult> {
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

  // Determine server mode
  let serverMode: 'unknown' | 'cracked' | 'online' = pingResult.serverMode ?? 'unknown';
  if (serverMode === 'unknown' && pingResult.status?.data?.players?.sample) {
    const sample = pingResult.status.data.players.sample;
    const hasInvalidUUIDs = sample.some(
      (p: { id?: string }) =>
        p.id && (p.id.startsWith('00000000') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id))
    );
    const hasValidUUIDs = sample.some(
      (p: { id?: string }) => p.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)
    );
    if (hasValidUUIDs && !hasInvalidUUIDs) serverMode = 'online';
    else if (hasInvalidUUIDs) serverMode = 'cracked';
  }

  result.serverMode = serverMode;
  logger.info(`[Mode] Server mode: ${serverMode}`);

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
  const connectResult = await connectBot(
    {
      host: input.host,
      port: input.port,
      account: input.account,
      fallbackAccount: input.fallbackAccount,
      proxy,
      timeout: 15000,
      retries: 2,
      retryDelay: 2000,
      collectPlugins,
      pluginTimeout: input.pluginTimeout ?? 5000,
      enableAutoAuth: input.enableAutoAuth ?? true,
      authTimeout: input.authTimeout ?? 3000,
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
  } else {
    const errorMsg = connectResult.error?.message || 'Unknown error';
    const errorCode = connectResult.error?.code || 'UNKNOWN';
    const wasKicked = connectResult.error?.kicked ? ' (kicked)' : '';
    const kickReason = connectResult.error?.kickReason || '';
    logger.warn(`[Bot] Connection failed: ${errorCode}${wasKicked}${kickReason ? ` - ${redactProxy(kickReason)}` : ''} (${connectResult.attempts} attempts)`);
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
    serverAuth: connectResult.serverAuth,
  };

  const scanTime = Date.now() - scanStartTime;
  logger.info(`[Task] Scan completed in ${scanTime}ms`);

  return result;
}
