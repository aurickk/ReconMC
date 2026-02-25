<h1 align="center">ReconMC</h1>

<p align="center">A distributed Minecraft server scanning and reconnaissance platform built with TypeScript.</p>

## What It Does

ReconMC is a monorepo that provides tools for discovering and analyzing Minecraft servers at scale. It features a distributed architecture with coordinator agents, proxy support, and a web dashboard.

- **Distributed Scanning** - Coordinate multiple agents for parallel server discovery
- **Protocol Implementation** - Native Minecraft server ping with retry logic
- **Bot Layer** - Connect to servers via mineflayer with mandatory proxy support
- **REST API** - Fastify-based coordinator with PostgreSQL and Redis
- **Web Dashboard** - Standalone Astro + Vue dashboard for managing scans

## Architecture

```
┌─────────────────┐          ┌─────────────────┐     ┌──────────┐
│   Dashboard     │          │   Coordinator   │────▶│ Redis    │
│   (Standalone)  │──API────▶│   (API-only)    │     │ Queue    │
└─────────────────┘  Key     └────────┬────────┘     └──────────┘
                              (Port 3001)                  │
                                  │                       │
                                  ▼                       │
                           ┌──────────┐                  │
                           │PostgreSQL│                  │
                           │ (Servers)│                  │
                           └──────────┘                  │
                                                        │
                    ┌────────────┼────────────┐         │
                    ▼            ▼            ▼         │
              ┌──────────┐ ┌──────────┐ ┌──────────┐    │
              │  Agent   │ │  Agent   │ │  Agent   │────┘
              │  Worker  │ │  Worker  │ │  Worker  │
              └────┬─────┘ └────┬─────┘ └────┬─────┘
                   │            │            │
                   ▼            ▼            ▼
              ┌─────────────────────────────────┐
              │       Minecraft Servers         │
              └─────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| **@reconmc/scanner** | Core scanner with Minecraft protocol implementation, retry logic, and proxy support |
| **@reconmc/coordinator** | Fastify API server (API-only, no static file serving) |
| **@reconmc/agent** | Distributed worker that pulls scan jobs and reports results |
| **@reconmc/bot** | Minecraft bot connection layer using mineflayer with mandatory proxy |
| **@reconmc/dashboard** | Standalone web UI with its own Docker deployment |

## How Scanning Works

Agents poll the coordinator for scan jobs from a Redis queue. Each scan has two phases:

### Phase 1: Status Ping

1. **DNS Resolution** - Resolves hostname to IP, follows SRV records
2. **Protocol Handshake** - TCP connection with Minecraft status protocol (1.20+)
3. **Status Collection** - Version, player count/sample, MOTD, server icon, mod info
4. **Latency Measurement** - Ping packet round-trip time
5. **UUID Validation** - Queries Mojang API (Minetools/PlayerDB) to verify player UUIDs
6. **Server Mode Detection** - If all UUIDs are valid → online-mode; if all invalid → cracked

### Phase 2: Bot Connection

7. **Account Selection** - Uses detected server mode to choose appropriate account:
   - Online-mode servers: Microsoft account only
   - Cracked/unknown: Offline account first, Microsoft fallback
8. **Bot Login** - Connects via mineflayer through SOCKS proxy
9. **Auto-Auth** - Detects and responds to `/login` or `/register` prompts on cracked servers
10. **Plugin Detection** - Multiple methods:
    - Command tree packet (`declare_commands`) - extracts `plugin:command` namespaces
    - Tab completion - scans `/`, `/version`, `/plugins`, `/bukkit:`, etc.
    - `/plugins` command response parsing
    - Command signature matching (100+ known plugins)

### Data Collected

| Category | Information |
|----------|-------------|
| Server | Version, protocol, MOTD, icon, latency, resolved IP, geolocation |
| Players | Online/max count, player sample with names/UUIDs |
| Mode | Online/cracked/unknown (via Mojang UUID validation) |
| Plugins | Detected plugin names and detection method |
| Auth | Whether server requires `/login` or `/register`, auth type |

All connections route through SOCKS4/5 proxies for IP protection.

## Requirements

- **Docker** 24.0+
- **Docker Compose** 2.20+

## Deployment

### Backend Stack

1. **Clone the repository**
   ```bash
   git clone https://github.com/aurickk/ReconMC.git
   cd ReconMC
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env: set POSTGRES_PASSWORD and RECONMC_API_KEY
   ```

3. **Start the backend**
   ```bash
   docker compose up -d
   ```

### Services

| Service | Port | Description |
|---------|------|-------------|
| **coordinator** | 3001 | REST API server |
| **postgres** | - | PostgreSQL database |
| **redis** | - | Job queue |
| **agent** | - | Scan workers (scalable) |

### Dashboard (Testing UI)

```bash
cd dashboard
docker compose up -d --build
```

## Proxies & Accounts

Scans require proxies and accounts, managed through the API or dashboard.

### Proxies

SOCKS4/SOCKS5 proxies protect agent IPs and bypass restrictions:

| Field | Description |
|-------|-------------|
| `host:port` | Proxy address |
| `protocol` | `socks4` or `socks5` |
| `username:password` | Optional authentication |
| `maxConcurrent` | Max simultaneous scans (default: 3) |

**Allocation:** Selects proxy with lowest usage that hasn't hit `maxConcurrent`.

### Accounts

Two types for different server modes:

| Type | Fields | Use Case |
|------|--------|----------|
| `microsoft` | `accessToken`, `refreshToken` | Online-mode servers |
| `cracked` | `username` | Cracked/offline servers |

**Allocation:** Selects valid account with lowest usage. Microsoft tokens auto-refresh.

### Resource Flow

```
Scan Job → Allocate Proxy + Account → Agent Scans → Release Resources
                ↓
        (lowest usage, under maxConcurrent)
```

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL password | Required |
| `RECONMC_API_KEY` | API authentication key | Required |
| `RECONMC_DISABLE_AUTH` | Disable API auth | `false` |
| `CORS_ORIGINS` | Allowed CORS origins | Empty |
| `AGENT_COUNT` | Number of agent replicas | `3` |
| `TRUSTED_NETWORKS` | CIDR ranges for internal endpoints | Docker internal |

### Management

```bash
docker compose logs -f coordinator
docker compose logs -f agent
docker compose restart coordinator
docker compose down
docker compose down -v  # Remove volumes
```

## API Reference

See [API.md](./API.md) for complete API documentation.

**Authentication:**
- External requests require `X-API-Key` header
- Internal endpoints (agents) restricted to trusted Docker networks

## Development

### Prerequisites

- **Node.js** 18.0.0+
- **PostgreSQL** 14+
- **Redis** 6+

### Local Setup

```bash
npm install
cp .env.example .env
npm run db:push
npm run dev:coordinator    # API with hot reload
npm run dev:agent          # Agent worker
npm run dev:dashboard      # Dashboard (proxies to localhost:3001)
```

### Testing

```bash
npm run test
npm run test --workspace=@reconmc/scanner
node --test packages/scanner/src/__tests__/scanner.test.ts
```

### Building

```bash
npm run build
npm run clean
```

## Project Structure

```
ReconMC/
├── packages/
│   ├── scanner/              # Core scanning library
│   ├── coordinator/          # API server (API-only)
│   │   └── src/
│   │       ├── routes/       # Fastify routes
│   │       ├── services/     # Queue, resource allocation
│   │       └── db/           # Schema, Redis client
│   ├── agent/                # Worker process
│   ├── bot/                  # Bot connection layer
│   └── dashboard/            # Standalone web UI
│       ├── Dockerfile
│       ├── docker-compose.yml
│       └── nginx.conf.template
├── Dockerfile                # Coordinator/agent image
├── docker-compose.yml        # Backend stack
├── DEPLOYMENT.md             # Full deployment guide
├── API.md                    # API documentation
└── .env.example              # Environment configuration
```

## Tech Stack

- **Runtime**: Node.js 22 with TypeScript ES Modules
- **API**: Fastify with compression and CORS
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Queue**: Redis 7 with ioredis (Lists for O(1) operations)
- **Bot**: mineflayer with minecraft-protocol
- **Dashboard**: Astro + Vue 3 + Tailwind CSS (standalone nginx)
- **Validation**: Zod schemas
