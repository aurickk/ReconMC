# ReconMC

ReconMC is a distributed Minecraft server reconnaissance system. It scans servers to collect metadata such as version, player count, MOTD, server mode (online/cracked), installed plugins, and authentication requirements. Designed to run at scale using parallel scanning agents coordinated by a central API server.

---

## Table of Contents

- [Architecture](#architecture)
- [Packages](#packages)
- [Security & Robustness](#security--robustness)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Dashboard](#dashboard)
- [Discord Bot](#discord-bot)
- [API Reference](#api-reference)
- [Development](#development)
- [Testing](#testing)
- [Project Structure](#project-structure)

---

## Architecture

ReconMC follows a coordinator-agent architecture:

1. **Coordinator** — Fastify HTTP server managing scan queue, proxies, accounts, and agent registration. Stores data in PostgreSQL with Redis as optional queue accelerator.
2. **Agents** — Worker processes polling the coordinator for tasks. Each agent scans through a SOCKS proxy and reports results back. Auto-reconnects on coordinator failure.
3. **Scanner** — Low-level Minecraft protocol library: handshake, status parsing, SRV resolution, UUID-based server mode detection.
4. **Bot** — Mineflayer-based connector with Microsoft auth, plugin detection via command tree analysis, and auto-auth for cracked servers.
5. **Dashboard** — Web frontend for managing servers, proxies, accounts, agents, and viewing scan results.
6. **Discord Bot** — Discord integration for triggering scans and viewing results.

```
                         +----------------+
                         |   Dashboard    |
                         |  (Web UI)      |
                         +-------+--------+
                                 |
                                 v
+-------------+         +----------------+         +-----------+
| Discord Bot | ------> |  Coordinator   | <-----> | PostgreSQL|
+-------------+         |  (Fastify API) |         +-----------+
                         +-------+--------+
                                 |  ^
                         +-------+--+------+
                         |       |         |
                         v       v         v
                      Agent-1  Agent-2  Agent-N
                         |       |         |
                      (SOCKS) (SOCKS)  (SOCKS)
                         |       |         |
                      MC Server  MC Server ...
```

---

## Packages

| Package | Path | Description |
|---|---|---|
| `@reconmc/scanner` | `packages/scanner` | Minecraft protocol scanner with retry logic, SRV resolution, SOCKS proxy support, and JSON depth protection |
| `@reconmc/bot` | `packages/bot` | Mineflayer bot connector with Microsoft auth, plugin detection, and auto-auth |
| `@reconmc/coordinator` | `packages/coordinator` | Fastify API with PostgreSQL, Redis, Zod validation, rate limiting, and graceful shutdown |
| `@reconmc/agent` | `packages/agent` | Worker with auto-reconnection, exponential backoff registration, and resilient task reporting |
| `@reconmc/discord-bot` | `packages/discord-bot` | Discord bot for triggering scans and viewing results |
| `@reconmc/dashboard` | `packages/dashboard` | Web dashboard for managing the system |

---

## Security & Robustness

- **Input validation** — All API routes validated with Zod schemas (body, query params, path params)
- **Rate limiting** — Built-in per-IP rate limiter (120 req/min), internal agent routes excluded
- **Timing-safe auth** — API key comparison uses `crypto.timingSafeEqual` to prevent timing attacks
- **SSRF prevention** — Proxy hosts and resolved IPs checked against private ranges, localhost, link-local, and cloud metadata addresses
- **Log sanitization** — Control characters stripped, line breaks replaced, messages truncated to prevent log injection
- **Body size limit** — Request bodies capped at 2 MB
- **Graceful shutdown** — Coordinator closes DB pool, Redis connection, and HTTP server on SIGINT/SIGTERM
- **Agent resilience** — Registration retries with backoff (10 attempts), consecutive failure tracking, heartbeat/task-report error isolation
- **JSON depth protection** — Server status responses checked for excessive nesting to prevent stack overflow
- **Docker hardening** — Resource limits (CPU/memory) per service, isolated network, healthchecks, stop grace periods

---

## Requirements

- **Node.js** 18+
- **Docker** and **Docker Compose** (for containerized deployment)
- **PostgreSQL** 15+
- **Redis** 7+ (optional, improves queue performance)

---

## Installation

```bash
git clone https://github.com/FrannnnDev/ReconMC.git
cd ReconMC
npm install
cp .env.example .env
# Edit .env with your values
npm run build
```

---

## Configuration

All configuration via environment variables. See `.env.example` for the full reference.

### Coordinator

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `DATABASE_URL` | PostgreSQL connection string | Auto from `POSTGRES_PASSWORD` |
| `POSTGRES_PASSWORD` | PostgreSQL password | Required |
| `REDIS_URL` | Redis connection string | `redis://redis:6379` |
| `RECONMC_API_KEY` | API key for protected endpoints | Required unless auth disabled |
| `RECONMC_DISABLE_AUTH` | Disable API key checks | `false` |
| `CORS_ORIGINS` | Comma-separated allowed origins | None |

### Agent

| Variable | Description | Default |
|---|---|---|
| `COORDINATOR_URL` | Coordinator API URL | `http://localhost:3000` |
| `AGENT_ID` | Unique agent identifier | Auto from hostname |
| `POLL_INTERVAL_MS` | Queue poll interval (ms) | `5000` |

### Discord Bot

| Variable | Description | Default |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Bot token | Required |
| `DISCORD_CLIENT_ID` | Application client ID | Required |
| `DISCORD_GUILD_ID` | Guild for slash commands | Optional (global) |
| `BOT_OWNER_ID` | Restrict access to user | Optional |

### Debug

| Variable | Description | Default |
|---|---|---|
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `MC_DEBUG` | Verbose protocol logging | `false` |

---

## Deployment

### Docker Compose (recommended)

```bash
docker compose up --build
```

Starts PostgreSQL, Redis, coordinator (port 3001), and agent replicas. All services run in an isolated network with resource limits and healthchecks. Agents wait for coordinator readiness before starting.

```bash
AGENT_COUNT=5 docker compose up --build -d
docker compose logs -f coordinator
docker compose logs -f agent
```

### Manual

```bash
# Start PostgreSQL and Redis manually, then:
npm run start --workspace=@reconmc/coordinator
COORDINATOR_URL=http://localhost:3000 npm run start --workspace=@reconmc/agent
```

---

## Dashboard

```bash
npm run build --workspace=@reconmc/dashboard
npm run dev --workspace=@reconmc/dashboard
```

Static files are served from the coordinator automatically if `packages/dashboard/dist` exists.

---

## Discord Bot

1. Create app at [discord.com/developers](https://discord.com/developers/applications)
2. Create bot, copy token, enable required intents
3. Set `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID`

```bash
npm run build --workspace=@reconmc/discord-bot
npm run start --workspace=@reconmc/discord-bot
```

---

## API Reference

All endpoints prefixed with `/api`. Protected endpoints require `x-api-key` header. All request bodies validated with Zod schemas.

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | No | Health check (coordinator + Redis status) |
| `GET` | `/api/auth/status` | No | Auth requirement status |

### Servers

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/servers/add` | Yes | Add servers to scan queue |
| `GET` | `/api/servers` | Yes | List servers with latest results |
| `GET` | `/api/servers/:id` | Yes | Server details with scan history |
| `GET` | `/api/servers/by-address/:address` | Yes | Find server by address |
| `DELETE` | `/api/servers/:id` | Yes | Delete a server record |

### Queue

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/queue` | No | Queue status counts |
| `GET` | `/api/queue/entries` | No | List entries (filterable by status) |
| `POST` | `/api/queue/claim` | No | Agent claims next task |
| `POST` | `/api/queue/:id/complete` | No | Report scan completion |
| `POST` | `/api/queue/:id/fail` | No | Report scan failure |

### Agents

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/agents/register` | No | Register agent |
| `POST` | `/api/agents/heartbeat` | No | Agent heartbeat |
| `GET` | `/api/agents` | Yes | List agents |
| `DELETE` | `/api/agents/:id` | Yes | Remove agent |

### Accounts

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/accounts` | Yes | List accounts |
| `POST` | `/api/accounts` | Yes | Add account (validates Microsoft tokens) |
| `PUT` | `/api/accounts/:id` | Yes | Update account |
| `DELETE` | `/api/accounts/:id` | Yes | Delete account |
| `POST` | `/api/accounts/:id/validate` | Yes | Re-validate account |
| `PUT` | `/api/accounts/:id/tokens` | Yes | Update tokens (agent use) |
| `POST` | `/api/accounts/import` | Yes | Bulk import |
| `GET` | `/api/accounts/export` | Yes | Export active |

### Proxies

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/proxies` | Yes | List proxies |
| `POST` | `/api/proxies` | Yes | Add proxy |
| `PUT` | `/api/proxies/:id` | Yes | Update proxy |
| `DELETE` | `/api/proxies/:id` | Yes | Delete proxy |
| `POST` | `/api/proxies/import` | Yes | Bulk import (Webshare format) |
| `GET` | `/api/proxies/export` | Yes | Export active |

### Task Logs

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/tasks/:id/logs` | No | Submit task logs |
| `GET` | `/api/tasks/:id/logs` | Yes | Retrieve task logs |

---

## Development

```bash
npm run build                                    # Build all
npm run dev --workspace=@reconmc/coordinator     # Dev mode per package
npm run dev --workspace=@reconmc/agent
npm run dev --workspace=@reconmc/dashboard
```

### Database

Drizzle ORM with auto-migrations on startup.

```bash
npm run db:generate --workspace=@reconmc/coordinator   # Generate migrations
npm run db:push --workspace=@reconmc/coordinator       # Push schema (dev only)
```

---

## Testing

```bash
npm test                                # All packages
npm test --workspace=@reconmc/scanner   # Scanner only
npm test --workspace=@reconmc/bot       # Bot only
npm test --workspace=@reconmc/coordinator
```

Tests use Node.js built-in test runner via `tsx` for TypeScript support. Coverage includes protocol encoding, retry logic, JSON depth protection, UUID validation, proxy config, SSRF prevention, input sanitization, and agent ID validation.

---

## Project Structure

```
ReconMC/
  package.json              npm workspaces root
  tsconfig.base.json        Shared TypeScript config
  Dockerfile                Multi-stage Docker build
  docker-compose.yml        Services with resource limits and healthchecks
  entrypoint.sh             Agent entrypoint (wait-for-coordinator)
  .env.example              Environment variable reference
  packages/
    scanner/                Minecraft protocol scanner
      src/
        scanner.ts          Scanner with JSON depth protection
        protocol/           VarInt encoding, packet generation
        retry.ts            Exponential backoff retry
        srv.ts              SRV DNS lookup
        uuid.ts             UUID validation, server mode detection
        scanner.test.ts     Unit tests
    bot/                    Mineflayer bot connector
      src/
        bot-connector.ts    Connection with retry and fallback
        auth/               Microsoft OAuth, session tokens
        plugins/            Plugin detector, auto-auth
        proxy/              SOCKS proxy utilities
        bot.test.ts         Unit tests
    coordinator/            Fastify API server
      src/
        server.ts           Server setup, route registration, graceful shutdown
        db/                 Schema, migrations, Redis client
        routes/             Route handlers (Zod-validated)
        services/           Queue, agents, resource allocation
        middleware/         Auth (timing-safe), rate limiting
        coordinator.test.ts Unit tests
      drizzle/              SQL migrations
    agent/                  Scanning worker
      src/
        worker.ts           Polling loop with reconnection
        scanner.ts          Full scan orchestration
        config.ts           Configuration
        logger.ts           Log capture and forwarding
    discord-bot/            Discord integration
    dashboard/              Web frontend
```
