# syntax=docker/dockerfile:1
# Build from repo root: docker build -f services/gateway-service/Dockerfile .
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY common/package.json common/
COPY domain/package.json domain/
COPY services/gateway-service/package.json services/gateway-service/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production SERVICEPORT=8080 PORT=8080
RUN apk add --no-cache curl && adduser -D -u 10001 animaxia
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY common ./common
COPY domain ./domain
COPY services/gateway-service ./services/gateway-service
USER animaxia
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1
CMD ["bun", "services/gateway-service/server.js"]
