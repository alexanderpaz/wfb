# syntax=docker/dockerfile:1.7
# Production image: API (Fastify) + static web build, one process, non-root.
#   docker build -t wfb .
#   docker build --build-arg INSTALL_LIBREOFFICE=true -t wfb:office .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# openssl lets prisma detect the engine target (debian-openssl-3.0.x).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install && pnpm config set store-dir /pnpm/store --global

# Download every package of the lockfile into the store. The store lives in the
# layer (not a cache mount) so it is also reused from CI's registry/gha cache;
# the layer only changes with pnpm-lock.yaml.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile

FROM fetch AS deps
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --offline --filter '!@wfb/e2e'

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @wfb/web build && pnpm --filter @wfb/api build
# Production node_modules only. The prisma CLI stays for `migrate deploy` at startup;
# Its two extra copies of the query engine become links to the one in @prisma/client.
# Engine paths are pinned (PRISMA_*_ENGINE_*) because otherwise the CLI requires a
# writable engines dir, which fails for any PUID other than the image's node user.
RUN pnpm --filter @wfb/api deploy --legacy --prod /prod/api \
  && cd /prod/api \
  && ./node_modules/.bin/prisma generate \
  && rm -rf src test tsconfig.json tsup.config.ts vitest.config.ts \
  && find node_modules -name '*linux-musl*' -prune -exec rm -rf {} + \
  && engine="$(find "$PWD"/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client -name 'libquery_engine-*' | head -n1)" \
  && for dup in node_modules/.pnpm/prisma@*/node_modules/prisma/libquery_engine-* \
    node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/libquery_engine-*; do \
    ln -sfr "$engine" "$dup"; \
  done \
  && mkdir engines \
  && ln -sr "$engine" engines/libquery_engine.so.node \
  && ln -sr "$(find "$PWD"/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines -name 'schema-engine-*' | head -n1)" engines/schema-engine \
  && find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.map' \) -not -path '*/prisma/*' -delete \
  && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} +

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG INSTALL_LIBREOFFICE=false
ARG VERSION=0.1.0
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="wfb" \
  org.opencontainers.image.description="Web file browser (Windows Explorer style) with LDAP, Active Directory and OIDC login" \
  org.opencontainers.image.source="https://github.com/alexanderpaz/wfb" \
  org.opencontainers.image.url="https://github.com/alexanderpaz/wfb" \
  org.opencontainers.image.documentation="https://github.com/alexanderpaz/wfb/blob/main/deploy/COOLIFY.md" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.created="${CREATED}" \
  org.opencontainers.image.base.name="docker.io/library/node:${NODE_VERSION}-bookworm-slim"
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && if [ "$INSTALL_LIBREOFFICE" = "true" ]; then \
       apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-liberation; \
     fi \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/man/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  WEB_DIST=/app/web \
  DATA_DIR=/app/data \
  SHARES_CONFIG=/config/shares.yaml \
  OFFICE_PREVIEW=${INSTALL_LIBREOFFICE} \
  APP_VERSION=${VERSION} \
  NODE_OPTIONS=--enable-source-maps \
  CHECKPOINT_DISABLE=1 \
  PRISMA_HIDE_UPDATE_MESSAGE=1 \
  PRISMA_QUERY_ENGINE_LIBRARY=/app/engines/libquery_engine.so.node \
  PRISMA_SCHEMA_ENGINE_BINARY=/app/engines/schema-engine
WORKDIR /app
COPY --from=build --chown=node:node /prod/api ./
COPY --from=build --chown=node:node /repo/apps/web/dist ./web
COPY --chmod=0755 deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Volumes start as copies of these dirs: world-writable so any PUID:PGID can use them.
RUN mkdir -p /app/data/thumbs /app/data/office /app/data/uploads /config /data/shares \
  && chown -R node:node /app/data && chmod -R 1777 /app/data
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
