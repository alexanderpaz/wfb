# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter '!@wfb/e2e'
COPY . .
RUN pnpm --filter @wfb/web build && pnpm --filter @wfb/api build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --filter @wfb/api deploy --legacy --prod /prod/api \
  && cd /prod/api && npx prisma generate

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG INSTALL_LIBREOFFICE=false
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini curl \
  && if [ "$INSTALL_LIBREOFFICE" = "true" ]; then \
       apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu; \
     fi \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web DATA_DIR=/app/data SHARES_CONFIG=/config/shares.yaml
WORKDIR /app
COPY --from=build --chown=node:node /prod/api ./
COPY --from=build --chown=node:node /repo/apps/web/dist ./web
COPY --chown=node:node deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/data /config /data/shares \
  && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
