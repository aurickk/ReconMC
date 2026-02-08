# ReconMC Coordinator API Documentation

REST API for the ReconMC scanning coordinator. All endpoints return JSON.

**Base URL:** `http://localhost:3000` (default) or `http://localhost:3001` when exposed via docker-compose

**Response Compression:** All JSON responses are gzipped by default for reduced bandwidth.

---

## Authentication

Most endpoints require an API key passed via the `X-API-Key` header:

```bash
curl -H "X-API-Key: your-key-here" http://localhost:3001/api/servers
```

Set `RECONMC_API_KEY` environment variable to enable authentication. Set `RECONMC_DISABLE_AUTH=true` to disable (development only).

**Public endpoints** (no API key required):
- `/api/health`
- `/api/auth/status`
- `/api/agents/register`
- `/api/agents/heartbeat`
- `/api/queue`
- `/api/queue/claim`
- `/api/queue/:id/complete`
- `/api/queue/:id/fail`
- `/api/tasks/:id/logs` (POST)

---

## Health & Auth

### GET /api/health

Check service health and Redis availability.

**Response:**
```json
{
  "status": "ok",
  "service": "coordinator",
  "redis": "ok"
}
```

### GET /api/auth/status

Check if authentication is required.

**Response:**
```json
{
  "authRequired": true
}
```

---

## Queue Management

### GET /api/queue

Get queue statistics.

**Response:**
```json
{
  "pending": 150,
  "processing": 3,
  "completed": 5420,
  "failed": 12,
  "totalServers": 1250
}
```

### GET /api/queue/entries

List queue entries with pagination and optional status filter.

**Query Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| status | string | "all" | Filter: "pending", "processing", "completed", "failed", "all" |
| limit | number | 100 | Max results |
| offset | number | 0 | Pagination offset |

**Response:**
```json
[
  {
    "id": "uuid",
    "serverAddress": "mc.hypixel.net",
    "hostname": "mc.hypixel.net",
    "resolvedIp": "51.222.13.145",
    "port": 25565,
    "status": "pending",
    "assignedAgentId": null,
    "assignedProxyId": null,
    "assignedAccountId": null,
    "createdAt": "2025-01-15T10:30:00.000Z",
    "startedAt": null,
    "completedAt": null,
    "errorMessage": null,
    "retryCount": 0
  }
]
```

### POST /api/queue/claim

Agent claims the next available server from the queue with proxy/account allocation.

**Request:**
```json
{
  "agentId": "agent-1"
}
```

**Success Response (200):**
```json
{
  "queueId": "uuid",
  "serverAddress": "mc.hypixel.net",
  "port": 25565,
  "proxy": {
    "id": "proxy-uuid",
    "host": "proxy.example.com",
    "port": 1080,
    "type": "socks5",
    "username": "user123",
    "password": "pass123"
  },
  "account": {
    "id": "account-uuid",
    "type": "microsoft",
    "username": "Steve",
    "accessToken": "token...",
    "refreshToken": "refresh..."
  }
}
```

**No Work Available (204):** Empty response

### POST /api/queue/:id/complete

Agent reports successful scan completion.

**Params:**
- `id` - Queue item UUID

**Request:**
```json
{
  "result": {
    "version": "1.20.4",
    "players": { "online": 1523, "max": 2000 },
    "motd": "Welcome to Hypixel!"
  }
}
```

**Response (200):**
```json
{
  "message": "Scan completed successfully"
}
```

### POST /api/queue/:id/fail

Agent reports scan failure.

**Params:**
- `id` - Queue item UUID

**Request:**
```json
{
  "errorMessage": "Connection timeout"
}
```

**Response (200):**
```json
{
  "message": "Scan failed and removed from queue"
}
```

---

## Servers

### POST /api/servers/add

Add server(s) to the scan queue. Duplicates are automatically skipped.

**Request:**
```json
{
  "servers": [
    "mc.hypixel.net",
    "play.mineplex.com:25565",
    "192.168.1.1:25565"
  ]
}
```

**Response (201):**
```json
{
  "added": 2,
  "skipped": 1,
  "queued": [
    {
      "id": "uuid-1",
      "serverAddress": "mc.hypixel.net",
      "resolvedIp": "51.222.13.145",
      "port": 25565
    },
    {
      "id": "uuid-2",
      "serverAddress": "play.mineplex.com:25565",
      "resolvedIp": "104.16.25.67",
      "port": 25565
    }
  ]
}
```

### GET /api/servers

List all scanned servers with latest results.

**Query Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 100 | Max results |
| offset | number | 0 | Pagination offset |

**Response:**
```json
[
  {
    "id": "uuid",
    "serverAddress": "mc.hypixel.net",
    "hostname": "mc.hypixel.net",
    "resolvedIp": "51.222.13.145",
    "port": 25565,
    "firstSeenAt": "2025-01-10T08:00:00.000Z",
    "lastScannedAt": "2025-01-15T12:30:00.000Z",
    "scanCount": 42,
    "latestResult": {
      "version": "1.20.4",
      "players": { "online": 1523, "max": 2000 }
    },
    "scanHistory": [...]
  }
]
```

### GET /api/servers/by-address/:address

Get a server by its address (hostname:port or hostname only). Useful for Discord bots.

**Params:**
- `address` - Server address (e.g., "mc.hypixel.net" or "mc.hypixel.net:25565")

**Response (200):**
```json
{
  "id": "uuid",
  "serverAddress": "mc.hypixel.net",
  ...
}
```

**Not Found (404):**
```json
{
  "error": "Server not found"
}
```

### GET /api/servers/:id

Get server with full scan history.

**Params:**
- `id` - Server UUID

**Response:**
```json
{
  "id": "uuid",
  "serverAddress": "mc.hypixel.net",
  "scanHistory": [
    {
      "timestamp": "2025-01-15T12:30:00.000Z",
      "result": { "version": "1.20.4", ... },
      "errorMessage": null,
      "duration": 1234,
      "logs": [
        { "level": "info", "message": "Connecting...", "timestamp": "..." }
      ]
    }
  ]
}
```

### DELETE /api/servers/:id

Delete a server record.

**Params:**
- `id` - Server UUID

**Response (200):**
```json
{
  "message": "Server deleted successfully"
}
```

### DELETE /api/servers/:id/scan/:timestamp

Delete a specific scan from server's history.

**Params:**
- `id` - Server UUID
- `timestamp` - ISO timestamp (URL encoded)

**Response (200):**
```json
{
  "message": "Scan deleted successfully"
}
```

---

## Agents

### POST /api/agents/register

Register a new scanning agent (public - agents in Docker network).

**Request:**
```json
{
  "agentId": "agent-1",
  "name": "Scanner Agent 1"
}
```

**Response (200):**
```json
{
  "id": "agent-1",
  "status": "idle",
  "lastHeartbeat": "2025-01-15T12:30:00.000Z",
  "registeredAt": "2025-01-15T12:30:00.000Z"
}
```

### POST /api/agents/heartbeat

Agent heartbeat to update status (public).

**Request:**
```json
{
  "agentId": "agent-1",
  "status": "busy",
  "currentQueueId": "queue-uuid"
}
```

**Response (200):**
```json
{
  "ok": true
}
```

### GET /api/agents

List all online agents.

**Response:**
```json
[
  {
    "id": "agent-1",
    "status": "busy",
    "currentQueueId": "queue-uuid",
    "lastHeartbeat": "2025-01-15T12:30:00.000Z"
  }
]
```

### DELETE /api/agents/:id

Remove an agent from the registry.

**Params:**
- `id` - Agent ID

**Response (200):**
```json
{
  "ok": true
}
```

---

## Task Logs

### POST /api/tasks/:id/logs

Submit log entries from an agent during a scan.

**Params:**
- `id` - Queue item UUID

**Request:**
```json
{
  "agentId": "agent-1",
  "logs": [
    { "level": "info", "message": "Connecting to server..." },
    { "level": "error", "message": "Connection timeout" }
  ]
}
```

**Response (200):**
```json
{
  "ok": true,
  "received": 2
}
```

### GET /api/tasks/:id/logs

Get logs for a queue item.

**Params:**
- `id` - Queue item UUID

**Query Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 100 | Max results (max 500) |
| offset | number | 0 | Pagination offset |

**Response:**
```json
[
  {
    "id": "log-uuid",
    "queueId": "queue-uuid",
    "agentId": "agent-1",
    "level": "info",
    "message": "Connecting to server...",
    "timestamp": "2025-01-15T12:30:00.000Z"
  }
]
```

---

## Proxies

### GET /api/proxies

List all proxies (without passwords).

**Response:**
```json
[
  {
    "id": "uuid",
    "host": "proxy.example.com",
    "port": 1080,
    "username": "user123",
    "protocol": "socks5",
    "currentUsage": 1,
    "maxConcurrent": 3,
    "isActive": true,
    "lastUsedAt": "2025-01-15T12:30:00.000Z",
    "createdAt": "2025-01-10T08:00:00.000Z"
  }
]
```

### GET /api/proxies/export

Export all active proxies including passwords (for backup/reimport).

**Response:**
```json
[
  {
    "host": "proxy.example.com",
    "port": 1080,
    "username": "user123",
    "password": "pass123",
    "protocol": "socks5",
    "maxConcurrent": 3
  }
]
```

### POST /api/proxies

Add a new proxy.

**Request:**
```json
{
  "host": "proxy.example.com",
  "port": 1080,
  "username": "user123",
  "password": "pass123",
  "protocol": "socks5",
  "maxConcurrent": 3
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "host": "proxy.example.com",
  "port": 1080,
  "username": "user123",
  "protocol": "socks5",
  "currentUsage": 0,
  "maxConcurrent": 3,
  "isActive": true,
  "lastUsedAt": null,
  "createdAt": "2025-01-15T12:30:00.000Z"
}
```

### PUT /api/proxies/:id

Update a proxy.

**Request:**
```json
{
  "isActive": false,
  "maxConcurrent": 5
}
```

### DELETE /api/proxies/:id

Delete a proxy.

**Response (204):** Empty

### POST /api/proxies/import

Bulk import proxies in Webshare format (`ip:port:user:pass` per line).

**Request:**
```json
{
  "content": "1.2.3.4:1080:user1:pass1\n5.6.7.8:1080:user2:pass2"
}
```

**Response (201):**
```json
{
  "imported": 2,
  "proxies": [...]
}
```

---

## Accounts

### GET /api/accounts

List all accounts (without tokens).

**Response:**
```json
[
  {
    "id": "uuid",
    "type": "microsoft",
    "username": "Steve",
    "currentUsage": 1,
    "maxConcurrent": 3,
    "isActive": true,
    "isValid": true,
    "lastValidatedAt": "2025-01-15T12:00:00.000Z",
    "lastValidationError": null,
    "lastUsedAt": "2025-01-15T12:30:00.000Z",
    "createdAt": "2025-01-10T08:00:00.000Z"
  }
]
```

### GET /api/accounts/export

Export all active accounts including tokens (for backup/reimport).

**Response:**
```json
[
  {
    "type": "microsoft",
    "username": "Steve",
    "accessToken": "eyJ...",
    "refreshToken": "M.R3...",
    "maxConcurrent": 3
  }
]
```

### POST /api/accounts

Add a new account with validation.

**Request:**
```json
{
  "type": "microsoft",
  "accessToken": "eyJ...",
  "refreshToken": "M.R3...",
  "maxConcurrent": 3
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "type": "microsoft",
  "username": "Steve",
  "currentUsage": 0,
  "maxConcurrent": 3,
  "isActive": true,
  "isValid": true,
  "lastValidatedAt": "2025-01-15T12:30:00.000Z",
  "createdAt": "2025-01-15T12:30:00.000Z"
}
```

**Validation Failure (400):**
```json
{
  "error": "Account validation failed",
  "details": "Invalid refresh token"
}
```

### PUT /api/accounts/:id

Update an account. If `accessToken` is provided for Microsoft accounts, re-validation occurs.

**Request:**
```json
{
  "isActive": false,
  "maxConcurrent": 5
}
```

### POST /api/accounts/:id/validate

Re-validate an existing account (refreshes Microsoft tokens if needed).

**Response:**
```json
{
  "valid": true,
  "username": "Steve",
  "error": null,
  "refreshed": true,
  "account": { ... }
}
```

### PUT /api/accounts/:id/tokens

Update account tokens (called by agents after token refresh).

**Request:**
```json
{
  "accessToken": "new-access-token",
  "refreshToken": "new-refresh-token"
}
```

**Response:**
```json
{
  "ok": true,
  "account": {
    "id": "uuid",
    "type": "microsoft",
    "username": "Steve",
    "isValid": true
  }
}
```

### DELETE /api/accounts/:id

Delete an account.

**Response (204):** Empty

### POST /api/accounts/import

Bulk import accounts with validation.

**Request:**
```json
{
  "accounts": [
    {
      "type": "microsoft",
      "accessToken": "eyJ...",
      "refreshToken": "M.R3..."
    }
  ]
}
```

**Response (201):**
```json
{
  "imported": 1,
  "successful": 1,
  "failed": 0,
  "accounts": [...]
}
```

---

## Error Responses

All endpoints may return error responses:

**400 Bad Request:**
```json
{
  "error": "Invalid input",
  "message": "agentId is required"
}
```

**401 Unauthorized:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing API key"
}
```

**404 Not Found:**
```json
{
  "error": "Not found"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Internal Server Error",
  "message": "An error occurred"
}
```

---

## Performance Notes

- **Response Compression:** All JSON responses are gzipped by default (70-90% size reduction)
- **Bulk Operations:** Use `/import` endpoints for adding multiple proxies/accounts
- **Pagination:** Use `limit` and `offset` params for large result sets
- **Duplicate Detection:** Servers are automatically deduplicated by `(resolved_ip, port, hostname)`
- **Indexing:** Database queries are optimized with partial indexes for status-based filtering
