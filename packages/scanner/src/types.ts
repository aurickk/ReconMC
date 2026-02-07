/**
 * Proxy configuration for scanner
 */
export interface ProxyConfig {
  host: string;
  port: number;
  type: 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

/**
 * Options for scanning a Minecraft server
 */
export interface ScanOptions {
  /** The server hostname or IP address */
  host: string;
  /** The server port (default: 25565) */
  port?: number;
  /** Connection timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Number of retry attempts (default: 3) */
  retries?: number;
  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelay?: number;
  /** Minecraft protocol version (default: 769 for 1.20+) */
  protocolVersion?: number;
  /** Whether to send a ping request for latency (default: true) */
  ping?: boolean;
  /** Whether to perform SRV record lookup (default: true) */
  SRVLookup?: boolean;
  /** Optional SOCKS proxy configuration */
  proxy?: ProxyConfig;
}

/**
 * IP geolocation information
 */
export interface IpLocation {
  /** Country code (e.g., "US", "GB", "DE") */
  country?: string;
  /** Country name */
  countryName?: string;
  /** City name */
  city?: string;
  /** ISP/Organization */
  isp?: string;
  /** Latitude */
  lat?: number;
  /** Longitude */
  lon?: number;
}

/**
 * Result of a server scan attempt
 */
export interface ScanResult {
  /** Whether the scan was successful */
  success: boolean;
  /** The hostname that was scanned (after SRV lookup) */
  host: string;
  /** The port that was scanned */
  port: number;
  /** The resolved IP address (after DNS resolution) */
  resolvedIp?: string;
  /** Geolocation information for the resolved IP */
  location?: IpLocation;
  /** Server status information (if successful) */
  status?: ServerStatus;
  /** Error message (if failed) */
  error?: string;
  /** Number of connection attempts made */
  attempts: number;
  /** Timestamp of the scan */
  timestamp: string;
  /** Detected server mode (online/cracked/unknown) - determined asynchronously */
  serverMode?: 'online' | 'cracked' | 'unknown';
  /** Validated player data with real UUIDs from Mojang API (populated when enableServerModeDetection is true) */
  validatedPlayers?: Array<{ name: string; id: string; originalId?: string }>;
}

/**
 * Minecraft server status information
 */
export interface ServerStatus {
  /** Raw JSON response from server */
  raw: string;
  /** Parsed JSON response (if valid) */
  data: ServerStatusData | null;
  /** Latency in milliseconds (if ping was enabled) */
  latency: number | null;
}

/**
 * Parsed server status data
 */
export interface ServerStatusData {
  /** Server version information */
  version: {
    /** Version name (e.g., "1.20.4") */
    name: string;
    /** Protocol version number */
    protocol: number;
  };
  /** Player information */
  players: {
    /** Current online player count */
    online: number;
    /** Maximum player capacity */
    max: number;
    /** Optional sample of online players */
    sample?: Array<{
      name: string;
      id: string;
    }>;
  };
  /** Server description/MOTD (can be string or JSON component) */
  description: string | DescriptionComponent;
  /** Optional server icon as base64 PNG */
  favicon?: string;
  /** Optional custom server mod information */
  modinfo?: {
    type: string;
    modList: Array<{
      modid: string;
      version: string;
    }>;
  };
}

/**
 * Minecraft text component (used for colored/formatting text)
 */
export interface DescriptionComponent {
  /** The text content */
  text?: string;
  /** Extra text components */
  extra?: DescriptionComponent[];
  /** Text formatting */
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
  /** Text color */
  color?: string;
}

/**
 * Internal packet state for Minecraft protocol
 */
export interface Packet {
  status: PacketStatus;
  meta: PacketMeta;
  dataBuffer: Uint8Array;
  fieldsBuffer: Uint8Array;
  crafted: PacketCrafted;
  error: Error | null;
}

export interface PacketStatus {
  handshakeBaked: boolean;
  pingSent: boolean;
  pingBaked: boolean;
  pingSentTime: number | null;
}

export interface PacketMeta {
  packetInitialized: boolean;
  metaCrafted: boolean;
  fieldsCrafted: boolean;
  packetID: number | null;
  dataLength: number | null;
  fullLength: number | null;
  metaLength: number | null;
}

export interface PacketCrafted {
  data: string | null;
  latency: number | null;
}
