import type { ProxyConfig } from '@reconmc/scanner';
// Import account types from auth module (single source of truth)
import type { CrackedAccount, MicrosoftTokenAccount, Account } from './auth/types.js';
// Re-export for convenience
export type { CrackedAccount, MicrosoftTokenAccount, Account } from './auth/types.js';

/**
 * NBT compound node types for parsing chat messages
 */
export interface NBTCompoundNode {
  type?: string;
  value?: NBTCompoundNode | NBTCompoundNode[] | string;
  text?: string;
  extra?: NBTCompoundNode[];
  with?: (NBTCompoundNode | string)[];
  translate?: string;
}

/**
 * Kick reason types from mineflayer
 */
export type KickReason = string | NBTCompoundNode;

/**
 * Mineflayer bot creation options
 * Based on mineflayer's createBot options
 */
export interface MineflayerBotOptions {
  username: string;
  host: string;
  port: number;
  version?: string | false;
  auth?: 'offline' | 'microsoft' | 'mojang';
  connect?: (client: unknown) => void;
  session?: {
    accessToken: string;
    clientToken: string;
    selectedProfile: {
      id: string;
      name: string;
    };
    availableProfiles?: Array<{
      id: string;
      name: string;
    }>;
  };
  accessToken?: string;
  haveCredentials?: boolean;
  disableChatSigning?: boolean;
  skipValidation?: boolean;
  hideErrors?: boolean;
  /** Allow additional mineflayer options not explicitly typed */
  [key: string]: unknown;
}

// Re-export ProxyConfig from @reconmc/scanner
export type { ProxyConfig } from '@reconmc/scanner';

/**
 * Bot connection options
 */
export interface BotConnectOptions {
  host: string;
  port?: number;
  account: Account;
  fallbackAccount?: Account;
  proxy: ProxyConfig;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  version?: string | false;
  /** Collect server plugins after spawn */
  collectPlugins?: boolean;
  /** Timeout for plugin detection in milliseconds (default: 5000) */
  pluginTimeout?: number;
  /** Enable auto-auth for cracked servers (default: true for cracked accounts) */
  enableAutoAuth?: boolean;
  /** Password to use for cracked server /login and /register (default: random) */
  authPassword?: string;
  /** Timeout in ms to wait for auth prompt (default: 3000) */
  authTimeout?: number;
}

/**
 * Error details for failed connections
 */
export interface BotError {
  code: string;
  message: string;
  kicked?: boolean;
  kickReason?: string;
}

/**
 * Spawn position in the world
 */
export interface SpawnPosition {
  x: number;
  y: number;
  z: number;
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

/**
 * Result of a bot connection attempt
 */
export interface BotConnectResult {
  success: boolean;
  host: string;
  port: number;
  username: string;
  uuid?: string;
  connectedAt?: Date;
  disconnectedAt?: Date;
  spawnPosition?: SpawnPosition;
  error?: BotError;
  attempts: number;
  latency?: number;
  accountType?: 'cracked' | 'microsoft';
  serverPlugins?: ServerPluginInfo;
  /** Authentication result for cracked servers */
  serverAuth?: ServerAuthInfo;
}

/**
 * Result of an individual connection attempt (internal use)
 */
export interface AttemptResult {
  success: boolean;
  host: string;
  port: number;
  username: string;
  uuid?: string;
  connectedAt: Date;
  spawnPosition?: SpawnPosition;
  latency?: number;
}

/**
 * Error codes for different failure scenarios
 */
export enum ErrorCode {
  CONNECTION_REFUSED = 'ECONNREFUSED',
  CONNECTION_TIMEOUT = 'ETIMEDOUT',
  KICKED_WHITELIST = 'KICKED_WHITELIST',
  KICKED_BANNED = 'KICKED_BANNED',
  KICKED_FULL = 'KICKED_FULL',
  KICKED_OTHER = 'KICKED',
  AUTH_FAILED = 'AUTH_FAILED',
  PROXY_ERROR = 'PROXY_ERROR',
  TOKEN_INVALID = 'TOKEN_INVALID',
  UNKNOWN = 'UNKNOWN',
}
