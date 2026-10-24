# Cal.com MCP Server - Streamable HTTP
# For self-hosting on VPS with nginx reverse proxy

# ---- Build stage -------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build

# ---- Runtime stage -----------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    ANALYTICS_DIR=/app/data

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# Non-root user; data + credentials directories (credentials are mounted read-only)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 -G nodejs && \
    mkdir -p /app/data /app/.credentials && \
    chown -R mcp:nodejs /app

USER mcp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/http-server.js"]
