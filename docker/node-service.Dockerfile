# syntax=docker/dockerfile:1.7
#
# One image recipe for the Node services that run from TypeScript source with tsx:
#   postman, courier, veridia, archive, stats  (build arg APP)
#
#   docker build -f docker/node-service.Dockerfile --build-arg APP=postman -t zipnet/postman:<git sha> .
#
# Stages: workspace install filtered to the app and its workspace deps (pnpm store in a BuildKit cache mount) ->
# Semaphore proving artifacts fetched and checked against the pinned SHA-256 manifest (only for apps that prove) ->
# slim runtime as the unprivileged `node` user. No secret is read at build time; keys arrive at runtime as Docker
# secrets (see docker/entrypoint.sh).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.12.3

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /repo

# ---------------------------------------------------------------------------------------------------------------------
FROM base AS build
ARG APP
RUN test -n "${APP}" || (echo "build arg APP is required (postman|courier|veridia|archive|stats)" >&2; exit 1)
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@zipnet/${APP}..." \
 && test -f "apps/${APP}/node_modules/tsx/dist/cli.mjs"

# ---------------------------------------------------------------------------------------------------------------------
# Semaphore v4 proving artifacts (gitignored, ~70 MB): downloaded at build time and verified against the SHA-256 pins
# in packages/sdk/artifacts/semaphore/manifest.json; a mismatch fails the build. Only apps that make Semaphore proofs
# in Node need them (SEMAPHORE_ARTIFACTS=1: veridia); the others get the manifest alone.
FROM ${NODE_IMAGE} AS semaphore
ARG SEMAPHORE_ARTIFACTS=0
WORKDIR /repo
COPY scripts/fetch-semaphore-artifacts.mjs scripts/
COPY packages/sdk/artifacts/semaphore/manifest.json packages/sdk/artifacts/semaphore/
RUN if [ "${SEMAPHORE_ARTIFACTS}" = "1" ]; then node scripts/fetch-semaphore-artifacts.mjs; else echo "semaphore artifacts skipped"; fi

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG APP
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="zipnet-${APP}" org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production APP=${APP} ZIPNET_GIT_SHA=${GIT_SHA}

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/apps/${APP} /repo/apps/${APP}
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=semaphore /repo/packages/sdk/artifacts/semaphore /repo/packages/sdk/artifacts/semaphore
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/zipnet-entrypoint
COPY docker/healthcheck.mjs /usr/local/lib/zipnet/healthcheck.mjs

# State lives in a mounted volume; the image itself stays read-only at runtime (compose: read_only + tmpfs /tmp)
RUN mkdir -p /var/lib/zipnet && chown node:node /var/lib/zipnet
USER node
WORKDIR /repo/apps/${APP}
ENTRYPOINT ["/usr/local/bin/zipnet-entrypoint"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
