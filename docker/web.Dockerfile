# syntax=docker/dockerfile:1.7
#
# The web app (apps/web): wallet and Emerald, served at app.<domain>; the framing headers are set by the edge proxy
# (deploy/compose/Caddyfile).
#
#   docker build -f docker/web.Dockerfile -t zipnet/web:<git sha> .
#
# Every setting is read at runtime (/api/config, server routes), so one image works for Sepolia and mainnet.
# Build needs ~2-3 GB of memory: build on the VPS with the services stopped, or on another machine and `docker save`.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.12.3

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /repo

# ---------------------------------------------------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@zipnet/web..."
# Semaphore v4 artifacts, verified against the pinned SHA-256 manifest (a mismatch fails the build). `pnpm build`
# runs apps/web/scripts/copy-artifacts.mjs first, which checks the hashes again and copies them into public/artifacts.
RUN node scripts/fetch-semaphore-artifacts.mjs
RUN pnpm --filter @zipnet/web build && rm -rf apps/web/.next/cache
# Drop dev dependencies (TypeScript, Tailwind, vitest) from the tree the runtime copies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --prod --filter "@zipnet/web..."

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="zipnet-web" org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 ZIPNET_GIT_SHA=${GIT_SHA} PORT=3100

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/apps/web/node_modules /repo/apps/web/node_modules
COPY --from=build /repo/apps/web/.next /repo/apps/web/.next
COPY --from=build /repo/apps/web/public /repo/apps/web/public
COPY --from=build /repo/apps/web/package.json /repo/apps/web/next.config.mjs /repo/apps/web/
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/zipnet-entrypoint
COPY docker/healthcheck.mjs /usr/local/lib/zipnet/healthcheck.mjs

# Mutable paths are mounts: /var/lib/zipnet (Emerald's budget file) and a tmpfs for
# .next/cache (created here so the unprivileged user can own the mount point)
RUN mkdir -p /var/lib/zipnet /repo/apps/web/.next/cache && chown node:node /var/lib/zipnet /repo/apps/web/.next/cache
USER node
WORKDIR /repo/apps/web
ENTRYPOINT ["/usr/local/bin/zipnet-entrypoint"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3100"]
