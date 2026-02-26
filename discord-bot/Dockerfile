FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
