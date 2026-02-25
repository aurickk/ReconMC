# ReconMC API Reference

Base URL: `http://localhost:3001/api`

## Authentication

Most endpoints require an API key passed via the `X-API-Key` header.

```bash
curl -H "X-API-Key: your-api-key" http://localhost:3001/api/servers
```

### Configuration

| Variable | Description |
|----------|-------------|
| `RECONMC_API_KEY` | Set your API key (required for production) |
| `RECONMC_DISABLE_AUTH=true` | Disable auth (development only) |

### Check Auth Status

```
GET /auth/status
```

**Response**
```json
{ "authRequired": true }
```

---

## Public Endpoints

These endpoints require no authentication (used by internal agents and dashboard).

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check for load balancers |
| `GET /auth/status` | Check if auth is required |
| `GET /dashboard/stats` | Dashboard statistics |
| `POST /agents/register` | Agent registration (Docker network) |
| `POST /agents/heartbeat` | Agent heartbeat (Docker network) |
| `POST /queue/claim` | Agent claim task |
| `POST /queue/:id/complete` | Agent complete task |
| `POST /queue/:id/fail` | Agent fail task |
| `POST /tasks/:id/logs` | Agent submit logs |
| `PUT /accounts/:id/tokens` | Agent update refreshed tokens |

---

## Servers

All server endpoints require authentication.

### Add Servers to Queue

```
POST /servers/add
```

**Request**
```json
{
  "servers": ["mc.example.com", "play.example.com:25566", "192.168.1.1"]
}
```

**Response** `201`
```json
{
  "added": 3,
  "skipped": 0,
  "queued": [
    { "id": "uuid", "serverAddress": "mc.example.com", "resolvedIp": "1.2.3.4", "port": 25565 }
  ]
}
```

### List Servers

```
GET /servers?limit=100&offset=0
```

**Response**
```json
[
  {
    "id": "uuid",
    "serverAddress": "mc.example.com",
    "hostname": "mc.example.com",
    "resolvedIp": "1.2.3.4",
    "port": 25565,
    "hostnames": ["mc.example.com", "play.example.com"],
    "lastScannedAt": "2024-01-15T10:30:00Z",
    "scanCount": 5,
    "latestResult": { ... },
    "scanHistory": [ ... ]
  }
]
```

### Search Servers

```
GET /servers/search?plugin=Essentials&players_min=10&sort_by=players
```

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | int | Max results (default: 100, max: 500) |
| `offset` | int | Pagination offset |
| `plugin` | string | Filter by plugin name (`*` for any) |
| `ip` | string | Filter by IP (partial match) |
| `name` | string | Filter by hostname (partial match) |
| `players_min` | int | Minimum online players |
| `players_max` | int | Maximum online players |
| `version` | string | Server version (partial match) |
| `motd` | string | MOTD content (partial match) |
| `is_online` | bool | Filter by online status |
| `account` | string | Account type: `microsoft`, `cracked`, `*` |
| `sort_by` | string | `last_scanned_at`, `first_seen_at`, `players` |
| `sort_order` | string | `asc` or `desc` (default: desc) |

**Response**
```json
{
  "servers": [ ... ],
  "totalCount": 150,
  "limit": 100,
  "offset": 0,
  "hasMore": true
}
```

### Get Server by ID

```
GET /servers/:id
```

### Get Server by Address

```
GET /servers/by-address/:address
```

Looks up server by hostname, IP, or `hostname:port`.

**Examples**
- `/servers/by-address/mc.example.com`
- `/servers/by-address/mc.example.com:25566`
- `/servers/by-address/192.168.1.1:25565`

### Delete Server

```
DELETE /servers/:id
```

### Delete Scan from History

```
DELETE /servers/:id/scan/:timestamp
```

### Purge All Data

```
DELETE /servers/purge
```

Deletes all servers, queue entries, and task logs. Does not affect accounts, proxies, or agents.

---

## Queue

Queue status and management endpoints require authentication. Agent operations (claim, complete, fail) are public for internal use.

### Get Queue Status

```
GET /queue
```

**Response**
```json
{
  "pending": 50,
  "processing": 3,
  "completed": 1200,
  "failed": 15,
  "totalServers": 1185
}
```

### Get Queue Entries

```
GET /queue/entries?status=pending&limit=100
```

**Query Parameters**
- `status` - `pending`, `processing`, `completed`, `failed`, `all`
- `limit` - Max results (default: 100)
- `offset` - Pagination offset

### Get Diagnostics

```
GET /queue/diagnostics
```

Returns resource availability and potential issues.

**Response**
```json
{
  "proxies": { "total": 5, "active": 5, "available": 3 },
  "accounts": { "total": 10, "active": 8, "valid": 7, "available": 5 },
  "agents": { "total": 3, "idle": 2, "busy": 1 },
  "queue": { "pending": 50, "processing": 3 },
  "stuckItems": 0,
  "issues": [],
  "canProcess": true
}
```

### Cancel Scan

```
DELETE /queue/:id
```

---

## Proxies

All proxy endpoints require authentication.

### List Proxies

```
GET /proxies
```

**Response**
```json
[
  {
    "id": "uuid",
    "host": "proxy.example.com",
    "port": 1080,
    "protocol": "socks5",
    "currentUsage": 2,
    "maxConcurrent": 3,
    "isActive": true
  }
]
```

### Add Proxy

```
POST /proxies
```

**Request**
```json
{
  "host": "proxy.example.com",
  "port": 1080,
  "username": "user",
  "password": "pass",
  "protocol": "socks5",
  "maxConcurrent": 3
}
```

### Update Proxy

```
PUT /proxies/:id
```

### Delete Proxy

```
DELETE /proxies/:id
```

### Import Proxies

```
POST /proxies/import
```

Import in Webshare format: `host:port:username:password` (one per line).

**Request**
```json
{
  "content": "proxy1.example.com:1080:user1:pass1\nproxy2.example.com:1080:user2:pass2"
}
```

### Export Proxies

```
GET /proxies/export
```

Returns all proxy data including passwords for backup/restore.

---

## Accounts

All account endpoints require authentication.

### List Accounts

```
GET /accounts
```

**Response**
```json
[
  {
    "id": "uuid",
    "type": "microsoft",
    "username": "Player123",
    "currentUsage": 1,
    "maxConcurrent": 3,
    "isActive": true,
    "isValid": true,
    "lastValidatedAt": "2024-01-15T10:00:00Z"
  }
]
```

### Add Account

```
POST /accounts
```

**Microsoft Account**
```json
{
  "type": "microsoft",
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "maxConcurrent": 3
}
```

**Cracked Account**
```json
{
  "type": "cracked",
  "username": "BotPlayer001",
  "maxConcurrent": 3
}
```

Accounts are validated on creation. Invalid accounts return an error.

### Update Account

```
PUT /accounts/:id
```

### Validate Account

```
POST /accounts/:id/validate
```

Re-validates account credentials. Microsoft accounts may have tokens refreshed.

**Response**
```json
{
  "valid": true,
  "username": "Player123",
  "refreshed": true,
  "account": { ... }
}
```

### Delete Account

```
DELETE /accounts/:id
```

### Import Accounts

```
POST /accounts/import
```

**Request**
```json
{
  "accounts": [
    { "type": "microsoft", "accessToken": "...", "refreshToken": "..." },
    { "type": "cracked", "username": "Bot001" }
  ]
}
```

### Export Accounts

```
GET /accounts/export
```

Returns all account data including tokens for backup/restore.

---

## Agents

Agent listing requires authentication. Registration and heartbeat are public for internal use.

### List Agents

```
GET /agents
```

**Response**
```json
[
  {
    "id": "agent-abc123",
    "name": "worker-1",
    "status": "busy",
    "currentQueueId": "uuid",
    "taskAddress": "mc.example.com:25565",
    "lastHeartbeat": "2024-01-15T10:30:00Z"
  }
]
```

### Remove Agent

```
DELETE /agents/:id
```

---

## Dashboard

### Get Stats

```
GET /dashboard/stats
```

Public endpoint for dashboard monitoring.

**Response**
```json
{
  "totalServers": 1185,
  "pendingScans": 50,
  "processingScans": 3,
  "onlineAgents": 3,
  "recentServers": [ ... ],
  "lastUpdated": "2024-01-15T10:30:00Z"
}
```

---

## Health

### Health Check

```
GET /health
```

Public endpoint for load balancers and monitoring.

**Response**
```json
{
  "status": "ok",
  "service": "coordinator",
  "redis": "ok"
}
```

---

## Error Responses

```json
{
  "error": "Error type",
  "message": "Detailed message"
}
```

| Code | Meaning |
|------|---------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |

---

## Examples

```bash
# Add servers
curl -X POST http://localhost:3001/api/servers/add \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"servers": ["mc.hypixel.net", "play.cubecraft.net"]}'

# Check queue status
curl -H "X-API-Key: your-key" http://localhost:3001/api/queue

# Search servers with Essentials plugin and 20+ players
curl -H "X-API-Key: your-key" \
  "http://localhost:3001/api/servers/search?plugin=Essentials&players_min=20"

# Add a proxy
curl -X POST http://localhost:3001/api/proxies \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"host": "proxy.example.com", "port": 1080, "protocol": "socks5"}'
```
