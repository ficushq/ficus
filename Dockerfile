# syntax=docker/dockerfile:1
# Tau Core Docker Image
#
# Multi-stage build producing a single image that can run as any of 3 services
# via the CMD override. This keeps images in sync and simplifies CI.
#
# Usage:
#   docker build -t tau-core:latest .
#   bun run core:build  (shortcut)
#
# Run as:
#   docker run tau-core:latest bun run apps/core/dist/index.js   # API server
#   docker run tau-core:latest bun run apps/core/dist/worker.js  # Worker
#   docker run tau-core:latest                                    # API (default)
#
# In K8s, each Deployment sets a different command — see k8s/core-deployment.yaml.

# Copy only workspace manifests while preserving their directory names. This works
# in both the monorepo and the extracted Core tree without naming private apps.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION} AS workspace-manifests
WORKDIR /manifests
RUN --mount=type=bind,source=apps,target=/workspace/apps \
    --mount=type=bind,source=packages,target=/workspace/packages \
    set -e; for manifest in /workspace/apps/*/package.json /workspace/packages/*/package.json; do \
      relative="${manifest#/workspace/}"; mkdir -p "$(dirname "$relative")"; cp "$manifest" "$relative"; \
    done

# --- Stage 1: Install dependencies and build ---
FROM oven/bun:${BUN_VERSION} AS builder

# Astro builds static docs with Node; the runtime image only needs Bun.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Copy package files first for layer caching
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --from=workspace-manifests /manifests/ ./

# Install git for submodule support, then clean up
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install all dependencies (including devDependencies for build)
# --ignore-scripts skips postinstall (submodule init — done via git below)
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY apps/ apps/
COPY packages/ packages/
COPY external/ external/
COPY config/ config/
COPY docs/ docs/
COPY scripts/ scripts/
# Brand sources: the farm (built with the web UI) imports the Ficus mark from brand/.
COPY brand/ brand/
COPY tsconfig.json ./

# Clone git submodules (COPY only copies empty dirs for submodules).
# No real git repo available, so we parse .gitmodules directly.
COPY .gitmodules ./
RUN git config -f .gitmodules --get-regexp 'submodule\..*\.path' | while read key path; do \
      url=$(git config -f .gitmodules submodule."$path".url); \
      echo "Cloning $url -> $path"; \
      rm -rf "$path" && git clone --depth 1 "$url" "$path"; \
    done
# Install production dependencies for extensions that have a package.json
RUN find config/agent/extensions -name package.json -maxdepth 2 -execdir bun install --production \;

ARG FICUS_INCLUDE_WEB=0
# PWA build id for the web UI. No .git in the build context, so pass e.g.
# --build-arg FICUS_BUILD_ID=$(git rev-parse --short=12 HEAD) for a stable id;
# unset falls back to a per-image timestamp.
ARG FICUS_BUILD_ID=

# Build core + CLI in parallel. Optionally also build the web UI for
# single-origin self-hosted deployments (FICUS_SERVE_WEB=1 at runtime).
# Wait on each background job explicitly so any build failure fails the image build.
RUN set -e; \
    bun run build:core & core_pid=$!; \
    bun run build:cli & cli_pid=$!; \
    wait "$core_pid"; \
    wait "$cli_pid"; \
    if [ "$FICUS_INCLUDE_WEB" = "1" ]; then \
      FICUS_BUILD_ID="$FICUS_BUILD_ID" bun run --filter web build; \
      test -f apps/web/dist/index.html; \
      test -f apps/web/dist/farm/index.html; \
    fi

# --- Stage 2: Production image ---
FROM oven/bun:${BUN_VERSION}-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl docker.io git jq openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    # Install Amazon RDS CA bundle so SSL connections to RDS just work
    && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /usr/local/share/ca-certificates/aws-rds-global-bundle.crt \
    && update-ca-certificates

WORKDIR /app

# OCI image metadata
LABEL org.opencontainers.image.title="Tau" \
      org.opencontainers.image.source="https://github.com/ficushq/tau" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Copy package files and install production deps only
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --from=workspace-manifests /manifests/ ./

RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/apps/core/dist apps/core/dist/
COPY --from=builder /app/apps/core/docs-dist apps/core/docs-dist/
COPY --from=builder /app/apps/cli/dist apps/cli/dist/

# Optionally include the built web UI (controlled by --build-arg FICUS_INCLUDE_WEB=1).
# When omitted, this copies nothing into apps/web/dist.
ARG FICUS_INCLUDE_WEB=0
COPY --from=builder /app/apps/web/ /tmp/web-src/
RUN if [ "$FICUS_INCLUDE_WEB" = "1" ] && [ -d /tmp/web-src/dist ]; then \
      mkdir -p apps/web && cp -r /tmp/web-src/dist apps/web/dist; \
    fi && rm -rf /tmp/web-src

# Copy runtime files (config from builder includes cloned submodules + installed extension deps)
COPY --from=builder /app/config/ config/
COPY apps/core/drizzle/ apps/core/drizzle/

# Create data directory for sessions and symlink CLI to PATH
RUN mkdir -p data/sessions && \
    ln -s /app/apps/cli/dist/ficus.js /usr/local/bin/ficus

# Default port (API server)
EXPOSE 3000

# Health check against API (only applies when running as API)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:${process.env.PORT||3000}/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Default: run API server. Override in K8s Deployment for worker/web.
CMD ["bun", "run", "apps/core/dist/index.js"]
