export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface ApiError {
  error: string;
  message?: string;
  details?: unknown;
}

export interface AuthStatus {
  authRequired: boolean;
}

export interface Server {
  id: string;
  serverAddress: string;
  hostname: string | null;
  resolvedIp: string | null;
  port: number;
  hostnames: string[] | null;
  latestResult: ServerScanResult | null;
  firstSeenAt: string | null;
  lastScannedAt: string | null;
  scanCount?: number;
}

export interface ServerScanResult {
  online: boolean;
  version: string | null;
  protocol: number | null;
  motd: string | null;
  playersOnline: number | null;
  playersMax: number | null;
  icon: string | null;
  plugins: Array<{ name: string; version: string }> | null;
  geo: { country: string; countryCode: string } | null;
  accountType: string | null;
  players?: Array<{ name: string; id: string }>;
  connection?: {
    username?: string;
    uuid?: string;
    accountType?: string;
  };
}

export interface Agent {
  id: string;
  name: string | null;
  status: string;
  currentQueueId: string | null;
  taskAddress: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Account {
  id: string;
  type: 'microsoft' | 'cracked';
  username: string | null;
  currentUsage: number;
  maxConcurrent: number;
  isActive: boolean;
  isValid: boolean;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface Proxy {
  id: string;
  host: string;
  port: number;
  username: string | null;
  protocol: 'socks4' | 'socks5';
  currentUsage: number;
  maxConcurrent: number;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface HealthStatus {
  status: string;
  service: string;
  redis: string;
}

export interface DashboardStats {
  totalServers: number;
  pendingScans: number;
  processingScans: number;
  onlineAgents: number;
  recentServers: RecentServer[];
  lastUpdated: string;
}

export interface RecentServer {
  id: string;
  address: string;
  status: 'online' | 'offline' | 'pending';
  mode: 'online' | 'cracked' | 'unknown';
  lastScanned: string | null;
  scanCount: number;
}

export interface QueueEntry {
  id: string;
  serverAddress: string;
  hostname: string | null;
  resolvedIp: string | null;
  port: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  assignedAgentId: string | null;
  assignedProxyId: string | null;
  assignedAccountId: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ServersResponse {
  servers: Server[];
  totalCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface QueueEntriesResponse {
  entries: QueueEntry[];
  totalCount: number;
  limit: number;
  offset: number;
}

export interface AccountImportResult {
  imported: number;
  successful: number;
  failed: number;
  accounts: Account[];
}

export interface ProxyImportResult {
  imported: number;
  proxies: Proxy[];
}

export interface AddToQueueResult {
  added: number;
  skipped: number;
  queued: Array<{ id: string; serverAddress: string }>;
}

export interface ScanHistoryEntry {
  timestamp: string;
  result: ServerScanResult | null;
  errorMessage?: string;
  duration?: number | null;
  logs?: Array<{ level: string; message: string; timestamp: string }>;
}

export interface ServerDetail extends Server {
  scanHistory: ScanHistoryEntry[];
}

export interface PlayerSample {
  name: string;
  id: string;
}
