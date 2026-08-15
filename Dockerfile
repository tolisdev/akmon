# Multi-stage Dockerfile for akMon (Lightweight Node 22 Alpine)
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build production SvelteKit bundle
RUN npm run build

# Production Runner Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package manifests and production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built application and backend files
COPY --from=builder /app/build ./build
COPY --from=builder /app/server ./server
COPY --from=builder /app/agents ./agents

# Create persistent data directory for SQLite database
RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "--experimental-sqlite", "--max-old-space-size=150", "server/index.js"]
