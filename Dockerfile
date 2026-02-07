# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/scanner/package.json ./packages/scanner/
COPY packages/bot/package.json ./packages/bot/
COPY packages/coordinator/package.json ./packages/coordinator/
COPY packages/agent/package.json ./packages/agent/
COPY tsconfig*.json ./

COPY packages ./packages/
RUN npm ci
RUN npm run build

# Stage 2: Runtime (smaller image, production deps only)
FROM node:22-alpine
RUN apk add --no-cache bind-tools curl

WORKDIR /app

# Copy package manifests and lockfile
COPY package*.json ./
COPY packages/scanner/package.json ./packages/scanner/
COPY packages/bot/package.json ./packages/bot/
COPY packages/coordinator/package.json ./packages/coordinator/
COPY packages/agent/package.json ./packages/agent/

# Copy built output from builder
COPY --from=builder /app/packages/scanner/dist ./packages/scanner/dist
COPY --from=builder /app/packages/bot/dist ./packages/bot/dist
COPY --from=builder /app/packages/coordinator/dist ./packages/coordinator/dist
COPY --from=builder /app/packages/agent/dist ./packages/agent/dist

# Copy database migrations
COPY --from=builder /app/packages/coordinator/drizzle ./packages/coordinator/drizzle

# Install production dependencies only
RUN npm ci --omit=dev

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "packages/coordinator/dist/index.js"]
