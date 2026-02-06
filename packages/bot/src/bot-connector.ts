/**
 * Bot connector with retry logic and spawn verification
 * Supports Microsoft token authentication via session-based auth
 */

import mineflayer from 'mineflayer';
import { createProxiedConnect } from './proxy';
import { getUsername, getAccountProfile, getAccountAuth } from './auth';
import { pluginDetector, autoAuth } from './plugins';
import type { BotConnectOptions, BotConnectResult, ServerPluginInfo, ServerAuthInfo, NBTCompoundNode, KickReason, MineflayerBotOptions } from './types';
import type { AutoAuthResult } from './plugins/auto-auth';
import { logger } from './logger.js';

// Extended bot properties (not extending Bot to avoid type conflicts)
interface BotExtensions {
  autoAuth?: {
    waitForAuth(): Promise<AutoAuthResult>;
  };
  pluginDetector?: {
    detectPlugins(options: { timeout?: number }): Promise<{ plugins: string[]; method: string; antiCheats: string[] }>;
  };
}

// Client with session property
interface ClientWithSession {
  session?: MineflayerBotOptions['session'];
  accessToken?: string;
}

/**
 * Delay helper for retry logic
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format UUID from undashed to dashed format
 * Minecraft profile API returns undashed UUIDs (32 chars)
 * but mineflayer may expect dashed format (8-4-4-4-12)
 */
function formatUuid(uuid: string): string {
  if (!uuid || uuid.length !== 32) {
    return uuid; // Already dashed or invalid
  }
  // Check if it's already dashed
  if (uuid.includes('-')) {
    return uuid;
  }
  // Add dashes: 8-4-4-4-12
  return `${uuid.substring(0, 8)}-${uuid.substring(8, 12)}-${uuid.substring(12, 16)}-${uuid.substring(16, 20)}-${uuid.substring(20, 32)}`;
}

/**
 * Parse NBT-style compound chat message
 * Format: { type: "compound", value: { ... } }
 */
function parseNBTCompound(node: string | NBTCompoundNode, depth: number = 0): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (depth > 10) return ''; // Prevent infinite recursion

  // Handle array first (arrays are objects)
  if (Array.isArray(node)) {
    return node.map((v) => parseNBTCompound(v, depth + 1)).join('');
  }

  // At this point, node is an NBTCompoundNode object - use any for complex nested types
  const nbt: any = node;

  // Handle direct text field
  if (typeof nbt.text === 'string') {
    return nbt.text;
  }

  // Handle string wrapper
  if (nbt.type === 'string' && nbt.value !== undefined) {
    return String(nbt.value);
  }

  // Handle compound
  if (nbt.type === 'compound' && nbt.value && typeof nbt.value === 'object') {
    let result = '';

    // Extract text field (could be string or wrapped)
    if (typeof nbt.value.text === 'string') {
      result += nbt.value.text;
    } else if (nbt.value.text) {
      result += parseNBTCompound(nbt.value.text, depth + 1);
    }

    // Extract extra array
    if (nbt.value.extra) {
      const extra = nbt.value.extra;
      if (Array.isArray(extra)) {
        result += extra.map((item: any) => parseNBTCompound(item, depth + 1)).join('');
      } else if (extra && typeof extra === 'object' && extra.type === 'list' && Array.isArray(extra.value)) {
        result += extra.value.map((item: any) => parseNBTCompound(item, depth + 1)).join('');
      } else if (extra && typeof extra === 'object' && extra.type === 'list' && extra.value && typeof extra.value === 'object' && extra.value.type === 'compound' && Array.isArray(extra.value.value)) {
        result += extra.value.value.map((item: any) => parseNBTCompound(item, depth + 1)).join('');
      }
    }

    return result;
  }

  // Handle list
  if (nbt.type === 'list' && nbt.value && typeof nbt.value === 'object') {
    if (Array.isArray(nbt.value)) {
      return nbt.value.map((v: any) => parseNBTCompound(v, depth + 1)).join('');
    }
    if (nbt.value.type === 'compound' && Array.isArray(nbt.value.value)) {
      return nbt.value.value.map((v: any) => parseNBTCompound(v, depth + 1)).join('');
    }
  }

  return '';
}

/**
 * Parse kick reason from mineflayer ChatMessage or string
 */
function parseKickReason(bot: mineflayer.Bot, reason: KickReason): string {
  try {
    // If reason is already a string, return it
    if (typeof reason === 'string') {
      return reason;
    }

    // If reason is a ChatMessage object, extract text
    if (reason && typeof reason === 'object') {
      // First, try to parse NBT compound format
      if (reason.type === 'compound') {
        const parsed = parseNBTCompound(reason);
        if (parsed) {
          return parsed.trim();
        }
      }

      // Try prismarine-chat-message parser
      try {
        const ChatMessage = require('prismarine-chat-message')(bot.version || '1.20.1');
        const parsed = new ChatMessage(reason);
        const result = parsed.toString();
        if (result && result !== '{}') return result;
      } catch {
        // Fall through
      }

      // Manual extraction from chat message structure
      if (reason.text) {
        return String(reason.text);
      }

      if (reason.translate) {
        let translated = reason.translate;
        if (reason.with && Array.isArray(reason.with)) {
          translated += ': ' + reason.with.map((w: NBTCompoundNode | string) => {
            if (typeof w === 'string') return w;
            if (typeof w === 'object' && w.text) return w.text;
            return parseNBTCompound(w);
          }).join(', ');
        }
        return translated;
      }

      // Last resort: try to parse as NBT
      const parsed = parseNBTCompound(reason);
      if (parsed) {
        return parsed.trim();
      }
    }
  } catch (err) {
    logger.error('[parseKickReason] Error parsing kick reason:', err);
  }

  return 'Unknown reason';
}

/**
 * Parse error into a structured error object
 */
function parseError(err: unknown): { code: string; message: string; kicked?: boolean; kickReason?: string } {
  if (err === null || err === undefined) {
    return { code: 'UNKNOWN', message: 'Unknown error' };
  }

  if (typeof err === 'object') {
    const error = err as Record<string, unknown>;

    // Check for kicked error
    if (error.kicked === true && 'reason' in error) {
      const reason = String(error.reason ?? 'Unknown reason');
      let code = 'KICKED';

      if (reason.toLowerCase().includes('whitelist')) {
        code = 'KICKED_WHITELIST';
      } else if (reason.toLowerCase().includes('banned') || reason.toLowerCase().includes('kick')) {
        code = 'KICKED_BANNED';
      } else if (reason.toLowerCase().includes('full')) {
        code = 'KICKED_FULL';
      }

      return {
        code,
        message: 'Kicked from server',
        kicked: true,
        kickReason: reason,
      };
    }

    // Check for standard error properties
    const message = typeof error.message === 'string'
      ? error.message
      : 'Unknown error';

    const code = typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';

    return { code, message };
  }

  return {
    code: 'UNKNOWN',
    message: String(err),
  };
}

/**
 * Create a bot with proxy support and proper Microsoft token auth
 * SECURITY: Proxy is MANDATORY - bot will NOT connect without a proxy
 */
async function createBot(
  options: BotConnectOptions,
  botRef: { bot: mineflayer.Bot | null }
): Promise<mineflayer.Bot> {
  const port = options.port ?? 25565;
  let username = getUsername(options.account);

  // SECURITY: Proxy is mandatory - fail fast if not provided
  if (!options.proxy) {
    throw new Error('Proxy is required for bot connection. Direct connections are not allowed for security reasons.');
  }

  // Log proxy usage for security audit
  logger.debug(`[BotConnector] Using ${options.proxy.type.toUpperCase()} proxy: ${options.proxy.host}:${options.proxy.port}`);

  // Variables for Microsoft auth
  let profile: { id: string; name: string } | null = null;
  let userHash: string | undefined = undefined;
  let accessToken: string | undefined = undefined;
  let sessionObject: {
    accessToken: string;
    clientToken: string;
    selectedProfile: { id: string; name: string };
    availableProfiles: { id: string; name: string }[];
  } | undefined = undefined;

  // Build bot options - use Partial to match mineflayer's BotOptions
  const botOptions: Partial<Record<string, unknown>> & {
    username: string;
    host: string;
    port: number;
  } = {
    username,
    host: options.host,
    port: port,
  };

  // Add version separately (it can be false which is not a string)
  if (options.version !== undefined) {
    (botOptions as Partial<Record<string, unknown>>).version = options.version;
  }

  // Add auth options
  if (options.account.type === 'cracked') {
    botOptions.auth = 'offline';
  } else if (options.account.type === 'microsoft') {
    // Authenticate using our own flow (bypass prismarine-auth completely)
    logger.debug('[BotConnector] Fetching Microsoft auth...');
    const authResult = await getAccountAuth(options.account);

    if (!authResult?.success) {
      logger.debug(`[BotConnector] Failed to fetch auth: ${authResult?.error ?? 'unknown error'}`);
      throw new Error(`Microsoft authentication failed: ${authResult?.error ?? 'unknown error'}`);
    }

    profile = authResult.profile ?? null;
    userHash = authResult.userHash;
    accessToken = authResult.accessToken;

    if (!profile || !accessToken) {
      throw new Error('Microsoft authentication failed: missing profile or access token');
    }

    logger.debug(`[BotConnector] Got profile: ${profile.name} (${profile.id})`);
    username = profile.name;
    botOptions.username = username;

    // Use session-based auth - this bypasses prismarine-auth completely
    // minecraft-protocol's encrypt.js uses both options.accessToken AND client.session
    const profileIdNoDashes = profile.id.replace(/-/g, '');

    // Set accessToken directly on options - used by encrypt.js for session join
    (botOptions as Partial<Record<string, unknown>>).accessToken = accessToken;

    // Set session object - minecraft-protocol copies this to client.session
    sessionObject = {
      accessToken: accessToken,
      clientToken: accessToken,  // Required by some code paths
      selectedProfile: {
        id: profileIdNoDashes,
        name: profile.name,
      },
      availableProfiles: [{
        id: profileIdNoDashes,
        name: profile.name,
      }],
    };
    (botOptions as Partial<Record<string, unknown>>).session = sessionObject;

    // Set haveCredentials to indicate we have valid auth
    (botOptions as Partial<Record<string, unknown>>).haveCredentials = true;

    // Disable chat signing (not needed for our use case and requires certificates)
    (botOptions as Partial<Record<string, unknown>>).disableChatSigning = true;

    logger.debug(`[BotConnector] Using session-based auth for: ${username} (${profileIdNoDashes})`);
  }

  // SECURITY: Proxy is mandatory - apply SOCKS proxy to all connections
  // This ensures the bot never connects directly to the server
  (botOptions as Partial<Record<string, unknown>>).connect = createProxiedConnect(options.proxy, options.host, port);
  logger.debug(`[BotConnector] Proxy connection configured for ${options.host}:${port}`);

  const bot = mineflayer.createBot(botOptions as any);
  botRef.bot = bot;

  // For Microsoft auth, manually set session on the underlying client
  // minecraft-protocol's encrypt.js reads from client.session.selectedProfile.id
  // but the session isn't always copied automatically from options
  if (options.account.type === 'microsoft' && accessToken && sessionObject && (bot as any)._client) {
    const client = (bot as any)._client;
    client.session = sessionObject;
    client.accessToken = accessToken;
    logger.debug(`[BotConnector] Session set on client: ${sessionObject.selectedProfile?.name || username}`);
  }

  return bot;
}

/**
 * Generate a random password for cracked server auth
 */
function generateAuthPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Options for connection attempt with telemetry
 */
interface AttemptOptions {
  /** Collect server plugins after spawn */
  collectPlugins?: boolean;
  /** Timeout for plugin detection in milliseconds */
  pluginTimeout?: number;
  /** Enable auto-auth for cracked servers */
  enableAutoAuth?: boolean;
  /** Password for auto-auth */
  authPassword?: string;
  /** Timeout for auth prompt */
  authTimeout?: number;
}

/**
 * Attempt a single connection with timeout
 */
async function attemptConnection(
  options: BotConnectOptions,
  attemptOptions?: AttemptOptions
): Promise<BotConnectResult> {
  const botRef: { bot: mineflayer.Bot | null } = { bot: null };
  const bot = await createBot(options, botRef);
  const timeout = options.timeout ?? 30000;
  const startTime = Date.now();
  let resolved = false;

  // Determine if we should use auto-auth (default true for cracked accounts)
  const useAutoAuth = attemptOptions?.enableAutoAuth ?? (options.account.type === 'cracked');
  const authPassword = attemptOptions?.authPassword ?? generateAuthPassword();
  const authTimeout = attemptOptions?.authTimeout ?? 3000;

  // Load auto-auth plugin for cracked accounts
  if (useAutoAuth) {
    logger.debug('[BotConnector] Loading AutoAuth plugin for cracked server authentication');
    bot.loadPlugin((b: mineflayer.Bot) => autoAuth(b, {
      password: authPassword,
      logging: true,
      ignoreRepeat: false,
      authTimeout: authTimeout,
    }));
  }

  // Load plugin detector if collecting plugins
  if (attemptOptions?.collectPlugins) {
    bot.loadPlugin(pluginDetector);
  }

  return new Promise<BotConnectResult>((resolve) => {
    const doResolve = (result: BotConnectResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      bot.end();
      doResolve({
        success: false,
        host: options.host,
        port: options.port ?? 25565,
        username: getUsername(options.account),
        accountType: options.account.type,
        error: {
          code: 'ETIMEDOUT',
          message: 'Connection timeout',
        },
        attempts: 1,
      });
    }, timeout);

    // Track spawn
    bot.once('spawn', async () => {
      const latency = Date.now() - startTime;

      // Get spawn position if available
      let spawnPosition: { x: number; y: number; z: number } | undefined;
      if (bot.entity && bot.entity.position) {
        spawnPosition = {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z),
        };
      }

      // Wait for authentication if using auto-auth
      let serverAuth: ServerAuthInfo | undefined;
      if (useAutoAuth && (bot as any).autoAuth) {
        try {
          logger.debug('[BotConnector] Waiting for server authentication...');
          const authResult: AutoAuthResult = await (bot as any).autoAuth.waitForAuth();
          serverAuth = {
            authRequired: authResult.authRequired,
            authType: authResult.authType,
            success: authResult.success,
            error: authResult.error,
          };
          
          if (authResult.authRequired) {
            logger.debug(`[BotConnector] Auth completed: type=${authResult.authType}, success=${authResult.success}`);
          } else {
            logger.debug('[BotConnector] No auth required by server');
          }

          // If auth failed, return error
          if (authResult.authRequired && !authResult.success) {
            bot.end();
            doResolve({
              success: false,
              host: options.host,
              port: options.port ?? 25565,
              username: bot.username,
              accountType: options.account.type,
              error: {
                code: 'AUTH_FAILED',
                message: authResult.error || 'Server authentication failed',
              },
              attempts: 1,
              serverAuth,
            });
            return;
          }
        } catch (err) {
          logger.debug(`[BotConnector] Auth wait failed: ${err}`);
          // Continue anyway - might not need auth
        }
      }

      // Collect server plugins if enabled (AFTER authentication)
      let serverPlugins: ServerPluginInfo | undefined;
      if (attemptOptions?.collectPlugins && (bot as any).pluginDetector) {
        try {
          logger.debug('[BotConnector] Detecting server plugins...');
          const pluginResult = await (bot as any).pluginDetector.detectPlugins({
            timeout: attemptOptions.pluginTimeout ?? 5000,
          });
          serverPlugins = {
            plugins: pluginResult.plugins,
            method: pluginResult.method,
          };
          logger.debug(`[BotConnector] Found ${pluginResult.plugins.length} plugins via ${pluginResult.method}`);
        } catch (err) {
          logger.debug(`[BotConnector] Plugin detection failed: ${err}`);
          serverPlugins = {
            plugins: [],
            method: 'none',
          };
        }
      }

      const result: BotConnectResult = {
        success: true,
        host: options.host,
        port: options.port ?? 25565,
        username: bot.username,
        uuid: bot.player?.uuid,
        connectedAt: new Date(),
        spawnPosition,
        latency,
        attempts: 1,
        accountType: options.account.type,
        serverPlugins,
        serverAuth,
      };

      bot.end();
      doResolve(result);
    });

    // Handle kick
    bot.once('kicked', (reason: KickReason, loggedIn: boolean) => {
      const reasonStr = parseKickReason(bot, reason);
      logger.debug(`[BotConnector] Kicked: ${reasonStr}`);

      // Parse kick reason
      let code = 'KICKED';

      if (reasonStr.toLowerCase().includes('whitelist')) {
        code = 'KICKED_WHITELIST';
      } else if (reasonStr.toLowerCase().includes('banned') || reasonStr.toLowerCase().includes('not allowed')) {
        code = 'KICKED_BANNED';
      } else if (reasonStr.toLowerCase().includes('server is full') || reasonStr.toLowerCase().includes('full')) {
        code = 'KICKED_FULL';
      } else if (reasonStr.toLowerCase().includes('multiplayer') || reasonStr.toLowerCase().includes('failed to login') || reasonStr.toLowerCase().includes('multiplayer.disconnect')) {
        code = 'AUTH_FAILED';
      }

      doResolve({
        success: false,
        host: options.host,
        port: options.port ?? 25565,
        username: bot.username,
        accountType: options.account.type,
        error: {
          code,
          message: 'Kicked from server',
          kicked: true,
          kickReason: reasonStr,
        },
        attempts: 1,
      });
    });

    // Handle error
    bot.once('error', (err: Error) => {
      logger.debug(`[BotConnector] Error: ${err.message}`);
      const error = parseError(err);

      doResolve({
        success: false,
        host: options.host,
        port: options.port ?? 25565,
        username: getUsername(options.account),
        accountType: options.account.type,
        error,
        attempts: 1,
      });
    });

    // Handle end (connection closed)
    bot.once('end', () => {
      // If we haven't resolved yet, this is an unexpected disconnect
      doResolve({
        success: false,
        host: options.host,
        port: options.port ?? 25565,
        username: getUsername(options.account),
        accountType: options.account.type,
        error: {
          code: 'DISCONNECTED',
          message: 'Connection closed unexpectedly',
        },
        attempts: 1,
      });
    });
  });
}

/**
 * Connect a bot with retry logic and fallback account types
 *
 * Account fallback logic:
 * - unknown: try offline -> if fails, try auth
 * - cracked: try offline -> if fails, try auth
 * - online: try auth only (error if fails)
 */
export async function connectBot(
  options: BotConnectOptions,
  serverMode: 'unknown' | 'cracked' | 'online' = 'unknown'
): Promise<BotConnectResult> {
  const retries = options.retries ?? 3;
  const retryDelay = options.retryDelay ?? 2000;

  // Determine which account types to try based on server mode
  const accountTypesToTry: ('cracked' | 'microsoft')[] = [];

  if (serverMode === 'online') {
    // Online mode: only try Microsoft accounts
    accountTypesToTry.push('microsoft');
  } else if (serverMode === 'cracked') {
    // Cracked mode: try cracked first, then Microsoft as fallback
    accountTypesToTry.push('cracked');
    accountTypesToTry.push('microsoft');
  } else {
    // Unknown mode: try cracked first, then Microsoft as fallback
    accountTypesToTry.push('cracked');
    accountTypesToTry.push('microsoft');
  }

  logger.info(`[Bot] Server mode: ${serverMode}, will attempt accounts: ${accountTypesToTry.join(' -> ')}`);

  // Track the last error across all account types for better error reporting
  let lastError: BotConnectResult | null = null;

  // Try each account type
  for (const accountType of accountTypesToTry) {
    // Determine which account to use for this attempt
    let connectionOptions: BotConnectOptions = options;

    if (accountType !== options.account.type) {
      // We need to use a different account type - check if we have a fallback account
      if (options.fallbackAccount && options.fallbackAccount.type === accountType) {
        logger.info(`[Bot] Trying fallback account: ${accountType === 'microsoft' ? 'Microsoft authentication' : 'cracked account'}`);
        connectionOptions = {
          ...options,
          account: options.fallbackAccount,
        };
      } else if (accountType === 'cracked') {
        // Generate a default cracked account
        const username = `ReconBot${Math.floor(Math.random() * 9999)}`;
        logger.info(`[Bot] Trying auto-generated cracked account (username redacted)`);
        connectionOptions = {
          ...options,
          account: { type: 'cracked', username },
        };
      } else {
        logger.debug(`[BotConnector] Skipping ${accountType} auth - no fallback account configured`);
        continue;
      }
    } else {
      // Log which account we're using for this attempt
      if (accountType === 'microsoft') {
        logger.info(`[Bot] Trying Microsoft authentication`);
      } else {
        logger.info(`[Bot] Trying cracked account (username redacted)`);
      }
    }

    // Try to connect with this account type
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await attemptConnection(connectionOptions, {
          collectPlugins: options.collectPlugins,
          pluginTimeout: options.pluginTimeout,
          enableAutoAuth: options.enableAutoAuth,
          authPassword: options.authPassword,
          authTimeout: options.authTimeout,
        });

        // If successful, return immediately
        if (result.success) {
          return { ...result, attempts: attempt };
        }

        lastError = result;

        // Check if this is a non-retryable error
        const nonRetryableCodes = ['KICKED_WHITELIST', 'KICKED_BANNED', 'KICKED_FULL'];
        if (result.error && nonRetryableCodes.includes(result.error.code)) {
          logger.debug(`[BotConnector] Non-retryable error: ${result.error.code}`);
          break; // Don't retry, try next account type
        }

        // If not the last attempt, wait before retrying
        if (attempt < retries) {
          await delay(retryDelay);
        }
      } catch (err) {
        lastError = {
          success: false,
          host: options.host,
          port: options.port ?? 25565,
          username: getUsername(connectionOptions.account),
          error: parseError(err),
          attempts: 1,
        };

        if (attempt < retries) {
          await delay(retryDelay);
        }
      }
    }

    // If this account type failed completely
    if (lastError) {
      // If it's an auth failure for Microsoft account, don't fall back
      if (accountType === 'microsoft' && lastError.error?.code === 'AUTH_FAILED') {
        logger.debug(`[BotConnector] Microsoft auth failed, not falling back`);
        return lastError;
      }

      // If it's an online mode server and auth failed, don't fall back to cracked
      if (serverMode === 'online' && accountType === 'microsoft') {
        logger.debug(`[BotConnector] Online mode server, auth failed - not falling back to cracked`);
        return lastError;
      }

      // Otherwise, try the next account type
      logger.debug(`[BotConnector] ${accountType} account failed, trying next type...`);
    }
  }

  // All account types failed - include last error details
  const lastErrorDetails = lastError?.error;
  return {
    success: false,
    host: options.host,
    port: options.port ?? 25565,
    username: getUsername(options.account),
    error: {
      code: 'ALL_FAILED',
      // Don't include kickReason in message - it will be shown separately
      message: lastErrorDetails?.kicked 
        ? 'Kicked from server'
        : lastErrorDetails?.message && !lastErrorDetails.kickReason
          ? lastErrorDetails.message
          : 'All connection attempts failed',
      kicked: lastErrorDetails?.kicked,
      kickReason: lastErrorDetails?.kickReason,
    },
    attempts: retries,
  };
}
