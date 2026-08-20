# Siaflex Sbee Intelligence — tek imajlı kurulum
# 1. aşama: Veeam MCP server'ı kaynaktan derle (farklı bir MCP için MCP_REPO'yu değiştirin)
FROM node:24-alpine AS mcp-builder
RUN apk add --no-cache git
ARG MCP_REPO=https://github.com/veeam-ai/veeam-mcp-server
ARG MCP_REF=main
WORKDIR /app
RUN git clone --depth 1 --branch ${MCP_REF} ${MCP_REPO} .
RUN npm ci && npm run build

# 2. aşama: web arayüzü bağımlılıkları
FROM node:24-alpine AS web-builder
WORKDIR /web
COPY app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 3. aşama: çalışma imajı
FROM node:24-alpine
WORKDIR /app
COPY --from=mcp-builder /app/build ./build
COPY --from=mcp-builder /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

WORKDIR /web
COPY --from=web-builder /web/node_modules ./node_modules
COPY app/server.js ./
COPY app/public ./public

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup && \
    mkdir -p /web/data && chown -R appuser:appgroup /app /web
USER appuser

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "/web/server.js"]
