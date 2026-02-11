>[!WARNING]
> This project is **vibecoded** from someone with minimal experience! Real developers have been warned!

# Work in Progress

- [ ] Web Dashboard - Frontend UI for viewing scan results, managing servers/accounts/proxies, and monitoring queue status
- [ ] Discord Bot - Discord integration for submitting servers, viewing results, and managing the system via commands

# ReconMC

A distributed Minecraft server reconnaissance system. ReconMC scans, collects information from, and analyzes Minecraft servers at scale using a coordinator-agent architecture.

## Overview

ReconMC consists of a central coordinator API that manages a task queue and multiple worker agents that perform parallel scanning operations. All bot connections are routed through SOCKS proxies for IP rotation, and the system supports both Microsoft authentication and offline-mode (cracked) servers.

### Architecture

```
                    +-------------------+
                    |   Coordinator API |
                    +-------------------+
                               |
                    +----------+----------+
                    |                     |
              +-----+-----+         +-----+-----+
              | PostgreSQL |         |   Redis   |
              +-----------+         +-----------+
                    |
         +----------+----------+
         |                     |
  +------+-----+        +------+-----+
  |  Agent 1   | ...    |  Agent N   |
  +------------+        +------------+
         |                     |
    +----+----+           +----+----+
    |  Proxy  |           |  Proxy  |
    +---------+           +---------+
         |
    Minecraft Servers
```

## Features

- **Scalable Architecture** - Coordinator/agent architecture supporting horizontal scaling
- **SOCKS Proxy Support** - All bot connections routed through proxies with connection pooling
- **Microsoft Authentication** - Full OAuth flow for online-mode servers with automatic token refresh
- **Server Mode Detection** - Automatically detects cracked vs online-mode servers
- **Plugin Detection** - Detects server plugins/mods when bot connects
- **Data Persistence** - PostgreSQL for storage with optional Redis for queue management
- **Automatic Recovery** - Stuck task recovery and retry logic

## Technology Stack

| Technology | Purpose |
|------------|---------|
| Node.js >= 18 | Runtime environment |
| TypeScript | Type-safe development |
| Fastify | HTTP server for coordinator API |
| Drizzle ORM | Database ORM |
| PostgreSQL | Primary database |
| Redis (optional) | Queue management |
| minecraft-protocol | Minecraft network protocol |
| mineflayer | Minecraft bot framework |

## Project Structure

```
ReconMC/
├── packages/
│   ├── scanner/      # Core Minecraft server scanning functionality
│   ├── bot/          # Minecraft bot connection layer (mineflayer)
│   ├── agent/        # Worker process that polls coordinator and executes scans
│   └── coordinator/  # Central API server and task queue management
├── docker-compose.yml
└── Dockerfile
```

### Packages

#### @reconmc/scanner

Core scanning functionality including TCP connection handling, Minecraft protocol packet generation/decoding, server mode detection, and SRV record lookup.

**Key exports:**
- `MinecraftScanner` - Main scanner class
- `scanServer()` - High-level scan function
- `refreshMicrosoftToken()` - Microsoft OAuth token refresh
- `validateTokenWithProfile()` - Token validation

#### @reconmc/bot

Minecraft bot connection layer using mineflayer with SOCKS proxy support and plugin detection.

**Key exports:**
- `connectBot()` - Bot connection with retry logic
- `getAccountAuth()` - Authentication for Microsoft/cracked accounts
- `testProxyConnection()` - Proxy connection testing
- `pluginDetector` - Mineflayer plugin for detecting server plugins

#### @reconmc/agent

Worker process that registers with the coordinator, claims tasks from the queue, executes scans, and reports results.

**Worker flow:**
1. Register with coordinator
2. Send periodic heartbeats
3. Poll for tasks
4. Run full scan (ping + bot connection)
5. Report result
6. Repeat

#### @reconmc/coordinator

Central API server with Fastify, task queue management, and database persistence.

**API Authentication:**

Protected routes require an API key passed via the `X-API-Key` header. Set the `RECONMC_API_KEY` environment variable to enable authentication.

**Public Routes** (no authentication):
- Agent operations (agents in Docker network)
- Server viewing and submission
- Queue operations

| Route | Method | Description |
|-------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/auth/status` | GET | Authentication status |
| `/api/queue` | GET | Queue status |
| `/api/queue/entries` | GET | Queue entries with filtering |
| `/api/queue/claim` | POST | Agent claims next task |
| `/api/queue/:id/complete` | POST | Agent completes scan |
| `/api/queue/:id/fail` | POST | Agent fails scan |
| `/api/agents/register` | POST | Agent registration |
| `/api/agents/heartbeat` | POST | Agent heartbeat |
| `/api/tasks/:id/logs` | POST | Agent submits task logs |
| `/api/servers/add` | POST | Add servers to scan queue |
| `/api/servers` | GET | List servers with pagination |
| `/api/servers/by-address/:address` | GET | Get server by address |
| `/api/servers/:id` | GET | Get server with scan history |
| `/api/accounts/:id/tokens` | PUT | Agent refreshes Microsoft tokens |

**Protected Routes** (require `X-API-Key` header):
- Administrative operations (accounts, proxies, agents, data deletion)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/agents` | GET | List online agents |
| `/api/agents/:id` | DELETE | Remove agent |
| `/api/tasks/:id/logs` | GET | Get task logs |
| `/api/servers/:id` | DELETE | Delete server record |
| `/api/servers/:id/scan/:timestamp` | DELETE | Delete scan from history |
| `/api/servers/purge` | DELETE | Purge all server data |
| `/api/accounts` | GET | List accounts |
| `/api/accounts/export` | GET | Export accounts (with tokens) |
| `/api/accounts` | POST | Add account |
| `/api/accounts/:id` | PUT | Update account |
| `/api/accounts/:id/validate` | POST | Validate account |
| `/api/accounts/:id` | DELETE | Delete account |
| `/api/accounts/import` | POST | Import accounts |
| `/api/proxies` | GET | List proxies |
| `/api/proxies/export` | GET | Export proxies (with passwords) |
| `/api/proxies` | POST | Add proxy |
| `/api/proxies/:id` | PUT | Update proxy |
| `/api/proxies/:id` | DELETE | Delete proxy |
| `/api/proxies/import` | POST | Import proxies |

## Database Schema

### Tables

#### servers
Stores discovered servers with scan history grouped by resolved IP + port.

#### scan_queue
Active scan queue with task status and agent assignments.

#### proxies
SOCKS proxy pool with concurrent connection limits.

#### accounts
Microsoft/cracked account pool with validation status.

#### agents
Registered worker agents with status tracking.

#### task_logs
Per-task logs from agents for debugging.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- (Optional) Node.js >= 18 for local development

### Docker Compose Deployment

1. Clone the repository:
```bash
git clone https://github.com/aurickk/ReconMC.git
cd ReconMC
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD
```

3. Start the stack:
```bash
docker compose up --build
```

This starts:
- PostgreSQL on port 5432 (internal)
- Redis on port 6379 (internal)
- Coordinator API on port 3001
- 3 agent replicas (configurable via `AGENT_COUNT`)

### Local Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run coordinator (development)
npm run dev:coordinator

# Run agent (development) - requires coordinator running
npm run dev:agent
```

### Database Migrations

```bash
# Generate migrations
npm run db:generate --workspace=@reconmc/coordinator

# Run migrations
npm run db:migrate --workspace=@reconmc/coordinator

# Push schema (development only)
npm run db:push --workspace=@reconmc/coordinator
```

## Configuration

### Environment Variables

**Coordinator:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HOST` | 0.0.0.0 | Bind address |
| `DATABASE_URL` | - | PostgreSQL connection string |
| `REDIS_URL` | - | Redis URL (optional) |
| `RECONMC_API_KEY` | - | API key for protected routes (generate with `openssl rand -hex 32`) |
| `RECONMC_DISABLE_AUTH` | false | Disable API key auth (development only) |
| `CORS_ORIGINS` | - | Allowed CORS origins |

**Agent:**
| Variable | Default | Description |
|----------|---------|-------------|
| `COORDINATOR_URL` | - | Coordinator API URL |
| `AGENT_ID` | auto | Agent identifier |
| `POLL_INTERVAL_MS` | 5000 | Task polling interval |

**Scanner:**
| Variable | Default | Description |
|----------|---------|-------------|
| `MC_DEBUG` | false | Enable Minecraft protocol logging |

## How It Works

1. Servers are submitted to the coordinator via the API
2. Coordinator creates scan tasks in the queue
3. Agents register on startup and poll for available tasks
4. When an agent claims a task, it receives a proxy and account assignment
5. Agent runs a full scan:
   - TCP handshake and server ping
   - Bot connection with plugin detection
   - Server information collection (players, MOTD, version, etc.)
6. Results are posted back to coordinator and stored in database

## Security

- **API Authentication** - Protected routes require API key via `X-API-Key` header
- **Input Sanitization** - HTML escaping for server-provided text, control character stripping
- **Rate Limiting** - JSON size/depth limits (100KB, 32 levels) prevent DoS
- **Validation** - Zod schema validation on all inputs
- **SSRF Protection** - Proxy host validation blocks private IPs and localhost
- **Log Injection Prevention** - Control characters and line breaks stripped from logs
- **Timing-Safe Comparisons** - API key validation uses timing-safe comparisons