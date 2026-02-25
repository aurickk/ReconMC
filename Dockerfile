# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

# Update npm to latest version
RUN npm install -g npm@latest

COPY package*.json ./
COPY packages/scanner/package.json ./packages/scanner/
COPY packages/bot/package.json ./packages/bot/
COPY packages/coordinator/package.json ./packages/coordinator/
COPY packages/agent/package.json ./packages/agent/
COPY tsconfig*.json ./

COPY packages ./packages/
# Use npm install for workspaces (npm ci doesn't support workspace:* protocol)
RUN npm install
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

# Install production dependencies only (use npm install for workspaces)
RUN npm install --production --ignore-scripts

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV NODE_ENV=production
CMD ["node", "packages/coordinator/dist/index.js"]
