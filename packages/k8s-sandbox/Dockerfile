# Ficus Sandbox — multi-stage build (3 stages, 2 published images)
#
#   base   — shared minimal core. Internal build stage; never run as a pod.
#   agent  — minimal per-agent light box  → tau-sandbox-agent  (sandboxType: agent)
#   squad  — full squad warm box (DinD + browsers + heavy devbox) → tau-sandbox
#
# Both leaf images derive from `base`, so BuildKit builds and caches the common
# layers once. The node then pulls those base layers once; the agent image's
# incremental pull is just its comfort-set devbox, and the squad image's is just
# its heavy delta.
#
# Build (BuildKit reuses the `base` stage across both targets):
#   docker build --target agent -t tau-sandbox-agent:latest -f packages/k8s-sandbox/Dockerfile .
#   docker build --target squad -t tau-sandbox:latest       -f packages/k8s-sandbox/Dockerfile .

# ============================================================================
# Stage: base — shared minimal core (ubuntu + nix + devbox + bun + server)
# NO docker, browsers, or heavy devbox packages — those live in the squad stage.
# ============================================================================
FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

# --- Minimal system essentials (shared by all sandbox roles) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    git \
    jq \
    openssh-client \
    rsync \
    sudo \
    unzip \
    wget \
    xz-utils \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# --- Nix (single-user mode) ---
RUN mkdir -m 0755 -p /nix /etc/nix \
    && echo 'build-users-group =' > /etc/nix/nix.conf \
    && echo 'filter-syscalls = false' >> /etc/nix/nix.conf \
    && echo 'experimental-features = nix-command flakes' >> /etc/nix/nix.conf \
    && curl -fsSL --retry 3 --retry-delay 5 https://nixos.org/nix/install | bash -s -- --no-daemon \
    && chmod -R a+rwX /nix

ENV PATH="/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"

# --- Devbox (no packages baked here — leaf stages bake their own) ---
RUN curl -fsSL --retry 3 --retry-delay 5 https://get.jetpack.io/devbox | bash -s -- -f \
    && chmod a+rx /usr/local/bin/devbox

# --- Bun runtime (for the sandbox server) ---
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# --- Tool executor service ---
COPY packages/k8s-sandbox/package.json /opt/sandbox/package.json
COPY packages/k8s-sandbox/src /opt/sandbox/src
# The executor depends on @ficus/shared as `workspace:*`, which bun can only
# resolve inside a workspace. Make /opt/sandbox that workspace: copy the member
# in and declare it on the executor's own manifest (same shape as
# apps/core/docker-sandbox/Dockerfile), so server.ts keeps its path.
COPY packages/shared/package.json /opt/sandbox/packages/shared/package.json
COPY packages/shared/src /opt/sandbox/packages/shared/src

WORKDIR /opt/sandbox
RUN bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.workspaces=["packages/shared"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' \
    && bun install --production
# Verify bun-pty (Bun built-in, no native addon needed) and the vendored workspace member resolve
RUN bun -e "require('bun-pty'); require('@ficus/shared/advisory-lock')" || (echo "ERROR: executor dependencies not available" && exit 1)

# --- Sandbox scaffolding ---
COPY packages/k8s-sandbox/sandbox/runtime-env.sh /opt/sandbox/runtime-env.sh
RUN chmod +x /opt/sandbox/runtime-env.sh

COPY packages/k8s-sandbox/sandbox/git-credential-github-token /usr/local/bin/git-credential-github-token
RUN chmod +x /usr/local/bin/git-credential-github-token

COPY packages/k8s-sandbox/sandbox/ssh_config.d/99-github-ssh-over-443.conf /etc/ssh/ssh_config.d/99-github-ssh-over-443.conf

COPY packages/k8s-sandbox/sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /workspace /memory /home/tau \
    && git config --global --add safe.directory /workspace \
    && git config --global --add safe.directory '*'

WORKDIR /workspace

EXPOSE 50051

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
    CMD curl -sf http://localhost:50051/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# ============================================================================
# Stage: agent — per-agent light box (tau-sandbox-agent)
# Base + a "comfort set" of ergonomic CLI tools (node/python runtimes +
# ripgrep/fd/tree/less/gh/tmux/procps) installed into the GLOBAL nix profile so
# they sit on PATH the instant the pod starts — no devbox activation and no Nix
# flake evaluation at runtime. No docker, no browsers, no heavy build toolchain
# — those stay in the squad image (reached via squad_bash). The agent's own
# devbox.json is empty, so the entrypoint skips `devbox install` entirely;
# agents still expand on demand with `devbox add`.
# ============================================================================
FROM base AS agent

# Empty default devbox template. In this image /opt/tau/defaults/devbox.json IS
# the (package-less) template the entrypoint seeds as the agent's own devbox in
# /private (FICUS_DEVBOX_DIR). With no packages declared, the entrypoint's
# `devbox install` is skipped — the comfort set already lives on PATH below.
COPY packages/k8s-sandbox/sandbox/devbox.agent.json /opt/tau/defaults/devbox.json

# Comfort set → global nix profile (/root/.nix-profile, already first on PATH via
# the base ENV). Installed at build time so the tools are on PATH at pod start
# with zero runtime cost: no `devbox install`, no flake evaluation, no nix-cache
# (agent boxes have none). This is the single biggest agent-box boot win — the
# old approach re-realized a devbox profile on every cold start (a ~constant Nix
# eval cost even when the packages were already pre-fetched).
RUN nix profile install \
        nixpkgs#nodejs_24 \
        nixpkgs#python3 \
        nixpkgs#ripgrep \
        nixpkgs#fd \
        nixpkgs#tree \
        nixpkgs#less \
        github:NixOS/nixpkgs/d5dfd8e6716dde34398bc14bc87c10dece9c8c68#gh \
        nixpkgs#tmux \
        nixpkgs#procps

# Agent prompts tell agents to attach screenshots with `gh --attach` (2.99.0+).
# Pin gh to the same Nixpkgs commit as the Devbox comfort sets (2.100.0).
# Check the actual capability so an incompatible package fails at build time.
RUN gh --version \
    && gh pr comment --help | grep -q -- '--attach'

# Manifest of base nix store paths (agent boxes don't use the nix-cache; kept for parity).
RUN ls /nix/store | sort > /nix-base-manifest.txt

# ============================================================================
# Stage: squad — full squad warm box (tau-sandbox)
# Base + Docker-in-Docker + headless-browser stack + the heavy devbox toolchain
# baked into /nix for instant startup. Reached by squad agents via `squad_bash`.
# ============================================================================
FROM base AS squad

ENV DEBIAN_FRONTEND=noninteractive

# --- Docker-in-Docker + headless browser runtime ---
# Headless browser support adds Playwright/Chromium runtime libraries, browser
# fonts, and Python venv support for the smoke test. The noble t64 package names
# are available on both amd64 and arm64.
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    iptables \
    python3 \
    python3-venv \
    fonts-freefont-ttf \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-unifont \
    xfonts-cyrillic \
    xfonts-scalable \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libstdc++6 \
    libudev1 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# --- Devbox packages (baked in for instant startup) ---
COPY packages/k8s-sandbox/sandbox/devbox.json /opt/tau/defaults/devbox.json

# Pre-install all devbox packages into /nix/store at build time.
# This adds ~1.2GB but eliminates 5+ min download on every pod start.
#
# Bake the resulting devbox.lock into the defaults so the runtime `devbox install`
# resolves to the SAME /nix/store paths that were baked here. Without it, the
# workspace seeds only devbox.json (with floating @latest pins), so the runtime
# re-resolves against a newer index and realizes a DIFFERENT ~850MB toolchain
# closure — which then gets treated as the nix-cache "delta" and re-saved/restored
# on every cold start (the baked toolchain becoming dead weight). The lock pins it.
RUN mkdir -p /tmp/devbox-install \
    && cp /opt/tau/defaults/devbox.json /tmp/devbox-install/devbox.json \
    && cd /tmp/devbox-install \
    && devbox install \
    && devbox run -- gh pr comment --help | grep -q -- '--attach' \
    && { devbox shellenv --init-hook > /dev/null 2>&1 || true; } \
    && { cp /tmp/devbox-install/devbox.lock /opt/tau/defaults/devbox.lock 2>/dev/null \
         || echo "[build] WARNING: no devbox.lock produced — runtime delta will not collapse"; } \
    && rm -rf /tmp/devbox-install

# Save manifest of base nix store paths so we can compute deltas at runtime.
# Squad-specific packages (not in base image) are cached as tarballs on EFS.
RUN ls /nix/store | sort > /nix-base-manifest.txt

# --- Headless browser smoke test ---
COPY packages/k8s-sandbox/scripts/smoke-headless-browser.sh /opt/sandbox/scripts/smoke-headless-browser.sh
RUN chmod +x /opt/sandbox/scripts/smoke-headless-browser.sh
