# Stage 1: Build the dashboard
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g npm@latest

COPY package*.json ./
COPY tsconfig.json ./
COPY astro.config.mjs ./
COPY components.json ./

COPY src ./src
COPY public ./public

RUN npm install
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

RUN apk add --no-cache curl gettext

COPY nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
