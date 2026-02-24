# Deployment Guide

## Quick Reference

| Command                        | Purpose                        |
| ------------------------------ | ------------------------------ |
| `npm run build:dashboard`        | Build dashboard to `dist/`     |
| `npm run dev:dashboard`          | Development server (port 5173) |
| `docker compose up -d`           | Start backend stack            |
| `docker compose --profile dashboard up -d` | Start with web UI |

## Docker Compose (Recommended)

### Quick Start

```bash
# Copy environment file
cp .env.example .env

# Edit .env and set POSTGRES_PASSWORD
# For production, also set RECONMC_API_KEY

# Start the stack
docker compose up -d
```

This starts:
- **PostgreSQL** - Database (internal)
- **Redis** - Queue/cache (internal)
- **Coordinator** - API server on port 3001
- **Agents** - 3 scan workers (default)

### With Dashboard

The web dashboard is optional and deployed using Docker Compose profiles:

```bash
# Start with dashboard
docker compose --profile dashboard up -d

# Or set in .env and use normal up
# DASHBOARD_PORT=8080
docker compose up -d
```

Dashboard will be available at `http://localhost:8080` (or `DASHBOARD_PORT`).

### Without Dashboard

```bash
# Start without dashboard (default)
docker compose up -d
```

Access the API directly at `http://localhost:3001/api/...`

## Building the Dashboard

### Local Build

```bash
# Build for production
npm run build:dashboard

# Output: packages/dashboard/dist/
# - index.html
# - _astro/*.js, *.css
```

### Preview Production Build

```bash
# After building
cd packages/dashboard
npm run preview
# Opens at http://localhost:4321
```

### Docker Build

The dashboard is built automatically inside the Docker image:

```bash
# Build dashboard image only
docker build -f Dockerfile.dashboard -t reconmc/dashboard .

# Run standalone (requires coordinator at http://coordinator:3000)
docker run -p 8080:80 \
  -e COORDINATOR_URL=http://your-coordinator:3001 \
  reconmc/dashboard
```

## Configuration

### Environment Variables

| Variable              | Required | Default   | Description                          |
| --------------------- | -------- | --------- | ------------------------------------ |
| `POSTGRES_PASSWORD`   | Yes      | -         | PostgreSQL password                  |
| `RECONMC_API_KEY`     | No       | -         | API key for authentication           |
| `RECONMC_DISABLE_AUTH`| No       | `false`   | Disable auth (dev only)              |
| `AGENT_COUNT`         | No       | `3`       | Number of scan agents                |
| `DASHBOARD_PORT`      | No       | `8080`    | Dashboard port (with `--profile dashboard`) |
| `CORS_ORIGINS`        | No       | -         | Allowed CORS origins                 |

### Production Checklist

- [ ] Set `POSTGRES_PASSWORD` to a secure random value
- [ ] Set `RECONMC_API_KEY` to a secure random value
- [ ] Set `RECONMC_DISABLE_AUTH=false`
- [ ] Configure `CORS_ORIGINS` for your domain
- [ ] Use HTTPS via reverse proxy (Traefik, Caddy, nginx)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Dashboard  │────▶│ Coordinator │────▶│  PostgreSQL │
│  (nginx)    │     │   (API)     │     │             │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    Redis    │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐        ┌─────────┐        ┌─────────┐
   │ Agent 1 │        │ Agent 2 │        │ Agent 3 │
   └─────────┘        └─────────┘        └─────────┘
```

## Manual Deployment

### Build Images

```bash
# Build coordinator/agent image
docker build -t reconmc/coordinator .

# Build dashboard image
docker build -f Dockerfile.dashboard -t reconmc/dashboard .
```

### Run Services

```bash
# Start PostgreSQL
docker run -d --name postgres \
  -e POSTGRES_DB=reconmc \
  -e POSTGRES_USER=reconmc \
  -e POSTGRES_PASSWORD=yourpassword \
  postgres:16-alpine

# Start Redis
docker run -d --name redis redis:7-alpine

# Start Coordinator
docker run -d --name coordinator \
  --link postgres:postgres \
  --link redis:redis \
  -e DATABASE_URL=postgres://reconmc:yourpassword@postgres:5432/reconmc \
  -e REDIS_URL=redis://redis:6379 \
  -p 3001:3000 \
  reconmc/coordinator

# Start Dashboard (optional)
docker run -d --name dashboard \
  --link coordinator:coordinator \
  -p 8080:80 \
  reconmc/dashboard
```

## Health Checks

All services include health checks:

```bash
# Check all services
docker compose ps

# Individual health
curl http://localhost:3001/api/health    # Coordinator
curl http://localhost:8080/health        # Dashboard
docker exec redis redis-cli ping         # Redis
```

## Troubleshooting

### Dashboard shows "Network Error"

Ensure the dashboard can reach the coordinator:
```bash
docker compose exec dashboard wget -qO- http://coordinator:3000/api/health
```

### Agents not connecting

Check agent logs:
```bash
docker compose logs agent
```

### Database connection failed

Reset PostgreSQL volume:
```bash
docker compose down
docker volume rm reconmc_postgres_data
docker compose up -d
```
