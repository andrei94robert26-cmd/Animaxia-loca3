# syntax=docker/dockerfile:1
# Build from repo root: docker build -f services/content-service/Dockerfile .
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY common/package.json common/
COPY domain/package.json domain/
COPY services/content-service/package.json services/content-service/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production SERVICEPORT=4002 PORT=4002
RUN apk add --no-cache curl && adduser -D -u 10001 animaxia
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY common ./common
COPY domain ./domain
COPY services/content-service ./services/content-service
USER animaxia
EXPOSE 4002
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1
CMD ["bun", "services/content-service/server.js"]
