/**
 * Coordinator API client for communicating with the ReconMC coordinator
 */
import { logger } from '../logger.js';
import type { McStatusData, McPlayer, McPlayers, McVersion } from './api.js';

export interface CoordinatorBatchRequest {
  servers: string[];
  name?: string;
}

export interface CoordinatorBatchRequest {
  servers: string[];
  name?: string;
}

export interface CoordinatorBatch {
  id: string;
  name: string | null;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  totalTasks: number;
  completedTasks: number;
  createdAt: string;
  completedAt: string | null;
}

export interface CoordinatorTask {
  id: string;
  batchId: string;
  serverAddress: string;
  port: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  result: {
    ping: {
      success: boolean;
      host: string;
      port: number;
      resolvedIp?: string;
      status?: {
        raw: string;
        data?: McStatusData;
        latency: number | null;
      };
      attempts: number;
      timestamp: string;
      serverMode?: 'online' | 'cracked' | 'unknown';
      validatedPlayers?: Array<{ name: string; id: string; originalId?: string }>;
    };
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
      serverPlugins?: { plugins: string[]; method: string; antiCheats: string[] };
      serverAuth?: { authRequired: boolean; authType?: string; success: boolean; error?: string };
    };
    serverMode?: 'online' | 'cracked' | 'unknown';
  } | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CoordinatorBatchResults {
  batch: CoordinatorBatch;
  tasks: CoordinatorTask[];
}

export interface CoordinatorHealth {
  status: string;
  uptime: number;
  version?: string;
}

/**
 * Scan result format compatible with the existing Discord embed code
 */
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
  validatedPlayers?: Array<{ name: string; id: string; originalId?: string }>;
}

/**
 * Server plugin detection result
 */
export interface ServerPluginInfo {
  plugins: string[];
  method: 'command_tree' | 'tab_complete' | 'combined' | 'plugins_command' | 'bukkit_plugins_command' | 'none';
  antiCheats: string[];
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

/**
 * Bot connection result
 */
export interface ConnectResult {
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
  serverPlugins?: ServerPluginInfo;
  serverAuth?: ServerAuthInfo;
}

/**
 * Full scan result with both ping and connection data
 */
export interface FullScanResult {
  ping: ScanResult;
  connection?: ConnectResult;
  serverMode?: 'online' | 'cracked' | 'unknown';
}

export class CoordinatorAPIClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private readonly POLL_INTERVAL_MS = 2000;
  private readonly MAX_POLL_TIME_MS = 120000; // 2 minutes max

  constructor(baseUrl: string = process.env.COORDINATOR_URL || 'http://localhost:3001') {
    // Remove trailing slash
    // Note: Default is 3001 which is the exposed port from Docker (internal is 3000)
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = process.env.RECONMC_API_KEY;
    logger.debug(`[CoordinatorAPI] Using base URL: ${this.baseUrl}`);
    logger.debug(`[CoordinatorAPI] Authentication ${this.apiKey ? 'enabled' : 'disabled (no API key configured)'}`);
  }

  /**
   * Build headers with API key if configured
   */
  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  /**
   * Check coordinator health
   */
  async checkHealth(): Promise<CoordinatorHealth> {
    const response = await fetch(`${this.baseUrl}/api/health`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json() as Promise<CoordinatorHealth>;
  }

  /**
   * Create a batch with a single server
   * Returns a simplified batch object with the batch ID
   */
  async createScanBatch(host: string, port: number = 25565): Promise<{ id: string; totalTasks: number }> {
    const server = port !== 25565 ? `${host}:${port}` : host;

    logger.debug(`[CoordinatorAPI] Creating batch for ${server}`);

    const response = await fetch(`${this.baseUrl}/api/batches`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        servers: [server],
        name: `Discord scan: ${server}`,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error((error as { message?: string }).message || `Failed to create batch: ${response.status}`);
    }

    // API returns { batchId, totalTasks, skippedDuplicates }
    const result = await response.json() as { batchId: string; totalTasks: number; skippedDuplicates: number };
    logger.debug(`[CoordinatorAPI] Batch created: ${result.batchId} (${result.totalTasks} tasks)`);
    
    return { id: result.batchId, totalTasks: result.totalTasks };
  }

  /**
   * Get batch results
   */
  async getBatchResults(batchId: string): Promise<CoordinatorBatchResults> {
    const response = await fetch(`${this.baseUrl}/api/batches/${batchId}/results`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get batch results: ${response.status}`);
    }

    return response.json() as Promise<CoordinatorBatchResults>;
  }

  /**
   * Convert coordinator task result to full scan result format (ping + connection)
   */
  private taskToScanResult(task: CoordinatorTask): FullScanResult {
    if (!task.result || !task.result.ping) {
      return {
        ping: {
          success: false,
          host: task.serverAddress,
          port: task.port,
          error: task.errorMessage || 'No result available',
          attempts: 1,
          timestamp: task.completedAt || new Date().toISOString(),
        },
      };
    }

    const ping = task.result.ping;
    return {
      ping: {
        success: ping.success,
        host: ping.host,
        port: ping.port,
        resolvedIp: ping.resolvedIp,
        status: ping.status,
        error: ping.success ? undefined : 'Server offline or unreachable',
        attempts: ping.attempts,
        timestamp: ping.timestamp,
        serverMode: ping.serverMode || task.result.serverMode,
        validatedPlayers: ping.validatedPlayers,
      },
      connection: task.result.connection ? {
        success: task.result.connection.success,
        host: task.result.connection.host,
        port: task.result.connection.port,
        username: task.result.connection.username,
        uuid: task.result.connection.uuid,
        connectedAt: task.result.connection.connectedAt,
        disconnectedAt: task.result.connection.disconnectedAt,
        spawnPosition: task.result.connection.spawnPosition,
        error: task.result.connection.error,
        attempts: task.result.connection.attempts,
        latency: task.result.connection.latency,
        accountType: task.result.connection.accountType,
        serverPlugins: task.result.connection.serverPlugins ? {
          plugins: task.result.connection.serverPlugins.plugins,
          method: task.result.connection.serverPlugins.method as 'command_tree' | 'tab_complete' | 'combined' | 'plugins_command' | 'bukkit_plugins_command' | 'none',
          antiCheats: task.result.connection.serverPlugins.antiCheats,
        } : undefined,
        serverAuth: task.result.connection.serverAuth ? {
          authRequired: task.result.connection.serverAuth.authRequired,
          authType: task.result.connection.serverAuth.authType as 'login' | 'register' | undefined,
          success: task.result.connection.serverAuth.success,
          error: task.result.connection.serverAuth.error,
        } : undefined,
      } : undefined,
      serverMode: ping.serverMode || task.result.serverMode,
    };
  }

  /**
   * Scan a server by creating a batch and polling for results
   * Returns a full scan result with both ping and connection data
   */
  async scanServer(host: string, port: number = 25565): Promise<FullScanResult> {
    const batch = await this.createScanBatch(host, port);
    return await this.waitForCompletion(batch.id);
  }

  /**
   * Wait for batch completion and return the full scan result
   */
  async waitForCompletion(batchId: string): Promise<FullScanResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.MAX_POLL_TIME_MS) {
      const results = await this.getBatchResults(batchId);

      // Check if batch is complete, failed, or cancelled
      if (results.batch.status === 'completed' ||
          results.batch.status === 'cancelled' ||
          (results.batch.completedTasks > 0 && results.batch.completedTasks >= results.batch.totalTasks)) {
        // Get the first (and only) task result
        if (results.tasks.length === 0) {
          throw new Error('No tasks found in batch');
        }

        const task = results.tasks[0];
        logger.debug(`[CoordinatorAPI] Batch ${batchId} complete, task status: ${task.status}`);

        return this.taskToScanResult(task);
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, this.POLL_INTERVAL_MS));
    }

    throw new Error('Scan timed out after 2 minutes');
  }

  /**
   * Cancel a batch
   */
  async cancelBatch(batchId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/batches/${batchId}/cancel`, {
      method: 'POST',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel batch: ${response.status}`);
    }
  }

  /**
   * Delete a batch
   */
  async deleteBatch(batchId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/batches/${batchId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete batch: ${response.status}`);
    }
  }
}
