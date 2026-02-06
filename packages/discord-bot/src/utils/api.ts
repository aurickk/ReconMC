/**
 * API client for communicating with the ReconMC API
 */
import { logger } from '../logger.js';

export interface ScanRequest {
  host: string;
  port?: number;
  timeout?: number;
  retries?: number;
  ping?: boolean;
}

export interface McPlayer {
  name?: string;
  username?: string;
  player_name?: string;
  id?: string;
}

export interface McPlayers {
  online?: number;
  max?: number;
  sample?: McPlayer[];
}

export interface McVersion {
  name?: string;
  protocol?: number;
}

export interface McStatusData {
  version?: McVersion;
  players?: McPlayers;
  description?: string | Record<string, unknown>;
  favicon?: string;
  [key: string]: unknown;
}

export interface ScanResult {
  success: boolean;
  host: string;
  port: number;
  resolvedIp?: string;
  status?: {
    raw: string;
    data?: McStatusData;
    latency: number | null;
  };
  error?: string;
  attempts: number;
  timestamp: string;
  serverMode?: 'online' | 'cracked' | 'unknown';
}

export interface AccountCracked {
  type: 'cracked';
  username: string;
}

export interface AccountMicrosoftToken {
  type: 'microsoft';
  accessToken: string;
  refreshToken?: string;
}

export type ApiAccount = AccountCracked | AccountMicrosoftToken;

export interface ProxyConfig {
  host: string;
  port: number;
  type: 'socks5' | 'socks4';
  username?: string;
  password?: string;
}

export interface ConnectRequest {
  host: string;
  port?: number;
  account?: ApiAccount;
  fallbackAccount?: ApiAccount;
  proxy?: ProxyConfig;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  version?: string | false;
  serverMode?: 'unknown' | 'cracked' | 'online';
  autoSelectAccount?: boolean;
  /** Collect server plugins after spawn */
  collectPlugins?: boolean;
  /** Timeout for plugin detection in milliseconds */
  pluginTimeout?: number;
}

export interface SpawnPosition {
  x: number;
  y: number;
  z: number;
}

export interface BotError {
  code: string;
  message: string;
  kicked?: boolean;
  kickReason?: string;
}

/**
 * Server plugin detection result
 */
export interface ServerPluginInfo {
  plugins: string[];
  method: 'command_tree' | 'tab_complete' | 'combined' | 'plugins_command' | 'bukkit_plugins_command' | 'none';
}

/**
 * Server authentication result (for cracked servers)
 */
export interface ServerAuthInfo {
  /** Whether authentication was required */
  authRequired: boolean;
  /** Type of auth performed (login or register) */
  authType?: 'login' | 'register';
  /** Whether auth was successful */
  success: boolean;
  /** Error if auth failed */
  error?: string;
}

export interface ConnectResult {
  success: boolean;
  host: string;
  port: number;
  username: string;
  uuid?: string;
  connectedAt?: string;
  disconnectedAt?: string;
  spawnPosition?: SpawnPosition;
  error?: BotError;
  attempts: number;
  latency?: number;
  accountType?: 'cracked' | 'microsoft';
  serverPlugins?: ServerPluginInfo;
  /** Authentication result for cracked servers */
  serverAuth?: ServerAuthInfo;
}

export interface FullScanRequest {
  host: string;
  port?: number;
  account?: ApiAccount;
  crackedUsername?: string;
  proxy?: ProxyConfig;
  options?: {
    timeout?: number;
    retries?: number;
    retryDelay?: number;
    version?: string | false;
  };
}

export interface FullScanResult {
  ping: ScanResult;
  connection?: ConnectResult;
  serverMode?: 'online' | 'cracked' | 'unknown';
}

/**
 * Account statistics response
 */
export interface AccountStatsResponse {
  totalAccounts: number;
  microsoftCount: number;
  hasMicrosoftAccounts: boolean;
  accountsFile: string;
}

/**
 * Accounts list response
 */
export interface AccountsListResponse {
  microsoft: Array<{ type: string; hasToken: boolean }>;
}

/**
 * Random account response
 */
export interface RandomAccountResponse {
  account: ApiAccount | null;
  accountType: 'cracked' | 'premium' | null;
  error?: string;
}

/**
 * Proxy statistics response
 */
export interface ProxyStatsResponse {
  totalProxies: number;
  socks4Count: number;
  socks5Count: number;
  authenticatedCount: number;
  proxiesFile: string;
}

/**
 * Proxies list response
 */
export interface ProxiesListResponse {
  proxies: Array<{
    host: string;
    port: number;
    type: string;
    hasAuth: boolean;
  }>;
}

/**
 * Random proxy response
 */
export interface RandomProxyResponse {
  proxy: ProxyConfig | null;
  error?: string;
}

export class APIClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.API_BASE_URL || 'http://localhost:3000') {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Scan a Minecraft server via the API with timeout
   */
  async scanServer(request: ScanRequest): Promise<ScanResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      logger.debug(`[APIClient] Starting scan for ${request.host}:${request.port || 25565}`);
      const startTime = Date.now();

      const response = await fetch(`${this.baseUrl}/api/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      const elapsed = Date.now() - startTime;
      logger.debug(`[APIClient] Response received in ${elapsed}ms, status: ${response.status}`);

      // Handle error responses (400, 500, etc)
      if (response.status === 503) {
        // Server scan failed (e.g., offline), but API worked
        // Return the scan result which will have success: false
        const result = await response.json() as ScanResult;
        logger.debug(`[APIClient] Scan returned 503 (server offline)`);
        return result;
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({
          message: 'Unknown error'
        }));
        logger.error(`[APIClient] API error: ${response.status}`, error);
        throw new Error((error as { message?: string }).message || `API error: ${response.status}`);
      }

      const result = await response.json() as ScanResult;
      logger.debug(`[APIClient] Scan successful: ${result.success}, serverMode: ${result.serverMode || 'unknown'}, elapsed total: ${Date.now() - startTime}ms`);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error(`[APIClient] Request timed out after 30s`);
        throw new Error('API request timed out after 30 seconds');
      }
      logger.error(`[APIClient] Request failed:`, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Connect a bot to a Minecraft server
   */
  async connectBot(request: ConnectRequest): Promise<ConnectResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout for bot connection

    try {
      logger.debug(`[APIClient] Starting bot connection to ${request.host}:${request.port || 25565}, mode: ${request.serverMode || 'unknown'}`);
      const startTime = Date.now();

      const response = await fetch(`${this.baseUrl}/api/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      const elapsed = Date.now() - startTime;
      logger.debug(`[APIClient] Bot connection response received in ${elapsed}ms, status: ${response.status}`);

      if (response.status === 503) {
        // Connection failed but API worked
        const result = await response.json() as { result: ConnectResult };
        logger.debug(`[APIClient] Bot connection returned 503 (failed)`);
        return result.result;
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({
          message: 'Unknown error'
        }));
        logger.error(`[APIClient] API error: ${response.status}`, error);
        throw new Error((error as { message?: string }).message || `API error: ${response.status}`);
      }

      const result = await response.json() as { result: ConnectResult };
      logger.debug(`[APIClient] Bot connection successful: ${result.result.success}`);
      return result.result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error(`[APIClient] Bot connection timed out after 60s`);
        throw new Error('Bot connection timed out after 60 seconds');
      }
      logger.error(`[APIClient] Bot connection failed:`, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Perform a full scan (ping + bot connection)
   */
  async fullScan(request: FullScanRequest): Promise<FullScanResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000); // 90 second timeout for full scan

    try {
      logger.debug(`[APIClient] Starting full scan for ${request.host}:${request.port || 25565}`);
      const startTime = Date.now();

      const response = await fetch(`${this.baseUrl}/api/scan/full`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      const elapsed = Date.now() - startTime;
      logger.debug(`[APIClient] Full scan response received in ${elapsed}ms, status: ${response.status}`);

      if (!response.ok) {
        const error = await response.json().catch(() => ({
          message: 'Unknown error'
        }));
        logger.error(`[APIClient] API error: ${response.status}`, error);
        throw new Error((error as { message?: string }).message || `API error: ${response.status}`);
      }

      const result = await response.json() as FullScanResult;
      logger.debug(`[APIClient] Full scan completed, ping success: ${result.ping.success}, serverMode: ${result.serverMode || 'unknown'}`);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error(`[APIClient] Full scan timed out after 90s`);
        throw new Error('Full scan timed out after 90 seconds');
      }
      logger.error(`[APIClient] Full scan failed:`, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get account statistics from the API
   */
  async getAccountStats(): Promise<AccountStatsResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/accounts/stats`);

      if (!response.ok) {
        throw new Error(`Failed to get account stats: ${response.status}`);
      }

      return response.json() as Promise<AccountStatsResponse>;
    } catch (error) {
      logger.error(`[APIClient] Get account stats failed:`, error);
      throw error;
    }
  }

  /**
   * Get all accounts from the API
   */
  async getAccounts(): Promise<AccountsListResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/accounts`);

      if (!response.ok) {
        throw new Error(`Failed to get accounts: ${response.status}`);
      }

      return response.json() as Promise<AccountsListResponse>;
    } catch (error) {
      logger.error(`[APIClient] Get accounts failed:`, error);
      throw error;
    }
  }

  /**
   * Get a random account from the API
   * @param type - Account type: 'cracked', 'premium', or 'auto' (default)
   * @param mode - Server mode for auto-selection: 'online', 'cracked', or 'unknown'
   */
  async getRandomAccount(
    type: 'cracked' | 'premium' | 'auto' = 'auto',
    mode: 'online' | 'cracked' | 'unknown' = 'unknown'
  ): Promise<RandomAccountResponse> {
    try {
      const params = new URLSearchParams({
        type,
        mode,
      });

      const response = await fetch(`${this.baseUrl}/api/accounts/random?${params}`);

      if (response.status === 404) {
        return { account: null, accountType: null, error: 'No accounts available' };
      }

      if (!response.ok) {
        throw new Error(`Failed to get random account: ${response.status}`);
      }

      return response.json() as Promise<RandomAccountResponse>;
    } catch (error) {
      logger.error(`[APIClient] Get random account failed:`, error);
      throw error;
    }
  }

  /**
   * Get proxy statistics from the API
   */
  async getProxyStats(): Promise<ProxyStatsResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/proxies/stats`);

      if (!response.ok) {
        throw new Error(`Failed to get proxy stats: ${response.status}`);
      }

      return response.json() as Promise<ProxyStatsResponse>;
    } catch (error) {
      logger.error(`[APIClient] Get proxy stats failed:`, error);
      throw error;
    }
  }

  /**
   * Get all proxies from the API
   */
  async getProxies(): Promise<ProxiesListResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/proxies`);

      if (!response.ok) {
        throw new Error(`Failed to get proxies: ${response.status}`);
      }

      return response.json() as Promise<ProxiesListResponse>;
    } catch (error) {
      logger.error(`[APIClient] Get proxies failed:`, error);
      throw error;
    }
  }

  /**
   * Get a random proxy from the API
   * @param method - Selection method: 'random' (default) or 'roundrobin'
   */
  async getRandomProxy(method: 'random' | 'roundrobin' = 'random'): Promise<RandomProxyResponse> {
    try {
      const params = new URLSearchParams({
        method,
      });

      const response = await fetch(`${this.baseUrl}/api/proxies/random?${params}`);

      if (response.status === 404) {
        return { proxy: null, error: 'No proxies available' };
      }

      if (!response.ok) {
        throw new Error(`Failed to get random proxy: ${response.status}`);
      }

      return response.json() as Promise<RandomProxyResponse>;
    } catch (error) {
      logger.error(`[APIClient] Get random proxy failed:`, error);
      throw error;
    }
  }

  /**
   * Check API health
   */
  async checkHealth(): Promise<{ status: string; uptime: number; version: string }> {
    const response = await fetch(`${this.baseUrl}/api/health`);

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }

    return response.json() as Promise<{ status: string; uptime: number; version: string }>;
  }
}
