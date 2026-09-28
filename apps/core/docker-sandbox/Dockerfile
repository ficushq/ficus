# Tau Sandbox Base Image
# Provides a Docker-in-Docker environment for agent execution.
#
# Supports two runtime modes:
# - sysbox (Linux): Secure, unprivileged DinD via sysbox-runc. Dockerd runs inside.
# - socket (macOS/Windows/Linux): Mounts host Docker socket. Uses host dockerd.
#
# Tools (docker, bun, node, git) are pre-installed so agents can work out of the box.
# Agents have root inside the container and can `apk add` anything else they need.

FROM docker:dind

LABEL io.hiretau.sandbox.managed="true" \
      io.hiretau.sandbox.runtime-contract="1" \
      io.hiretau.sandbox.executor-protocol="1" \
      io.hiretau.sandbox.command-contract="1"

# Install glibc compatibility (needed for compiled Bun binaries like the tau CLI).
# sgerrand/alpine-pkg-glibc only provides x86_64 packages — skip on arm64 (e.g. Apple Silicon).
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "amd64" ]; then \
    wget -q -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub \
    && wget -q https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.35-r1/glibc-2.35-r1.apk \
    && apk add --no-cache --force-overwrite glibc-2.35-r1.apk \
    && rm glibc-2.35-r1.apk \
    && mkdir -p /lib64 \
    && ln -sf /usr/glibc-compat/lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2; \
    fi

# Install system essentials (Alpine-based)
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    wget \
    unzip \
    tar \
    gzip \
    build-base \
    python3 \
    py3-pip \
    openssh-client \
    shadow \
    sudo \
    # Code search & navigation \
    ripgrep \
    fd \
    tree \
    less \
    # Process & network tools \
    procps \
    net-tools \
    bind-tools \
    # Patching & scripting \
    patch \
    diffutils \
    perl \
    # Docker Compose \
    docker-compose \
    # Runtime identity/proxy helpers \
    socat \
    su-exec \
    openssl

# Install Node.js (LTS)
RUN apk add --no-cache 'nodejs>=22.19.0' npm

# GitHub CLI, pinned to a release with `gh --attach` (2.99.0+), which agent
# prompts rely on for screenshots. Alpine's github-cli package lags releases by
# weeks; the official tarball is a static Go binary that runs fine on musl.
# The checksums come from gh_<version>_checksums.txt on the release and must
# move together with GH_VERSION.
ARG GH_VERSION=2.99.0
RUN case "$TARGETARCH" in \
      amd64) sha=ed4960225d2833e04a61590d9fa2b5773d147f3aa375459e5466a40c102f3832 ;; \
      arm64) sha=564eff56a61e8caf193efde16937fba879eb62a3a479c9dd6be2001e7647680b ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH for gh" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --retry 3 --retry-delay 5 -o /tmp/gh.tgz \
         "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
    && echo "$sha  /tmp/gh.tgz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tgz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && test "$(gh --version | sed -n 's/^gh version \([0-9.]*\).*/\1/p')" = "$GH_VERSION"

# Install the repository-pinned Bun system-wide.
ARG BUN_VERSION=1.4.2
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
    && test "$(bun --version)" = "$BUN_VERSION"

# Install Nix (single-user mode for containers) and Devbox.
# Devbox provides declarative, workspace-local package management via Nix.
# Tools installed with `devbox add` persist in the workspace's .devbox/ directory.
# Need coreutils for GNU cp (Nix installer uses --preserve= which BusyBox doesn't support).
# Create nixbld group with high gid to avoid conflicts with host user gids (typically 1000).
# Configure Nix for single-user mode (no build users).
RUN apk add --no-cache coreutils xz && \
    addgroup -g 30000 nixbld && \
    mkdir -p /etc/nix && echo 'build-users-group =' > /etc/nix/nix.conf && \
    curl -fsSL --retry 3 --retry-delay 5 https://nixos.org/nix/install | sh -s -- --no-daemon && \
    . ~/.nix-profile/etc/profile.d/nix.sh && \
    curl -fsSL --retry 3 --retry-delay 5 https://get.jetpack.io/devbox | bash -s -- -f && \
    chmod a+rx /usr/local/bin/devbox && \
    # Make nix store/db writable by all users (needed for non-root sandbox user)
    chmod -R a+rwX /nix

# Add Nix and Devbox to PATH for all users (single-user install puts nix in /root/.nix-profile)
ENV PATH="/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"

# --- Shared browser layout (dev parity with scripts/machine/bootstrap.sh) ------
# KEEP IN LOCKSTEP with bootstrap.sh install_browser / packages/machine-image
# (same PLAYWRIGHT_VERSION — asserted by bootstrap.test.ts — same /opt/tau/browser
# layout: pinned playwright node_modules + PLAYWRIGHT_BROWSERS_PATH). In docker
# mode a box IS the container, so the shared-per-machine sharing is moot, but the
# layout must match so the box server's browser code path is identical (spec
# §4.4). Phase 1 laid down the layout; Phase 2 runs the tau-browser service as a
# second in-container process (startup.sh) and the docker manager passes
# --shm-size=512m (apps/core/src/services/sandbox/docker/manager.ts).
#
# Alpine/musl: Playwright's Chromium is a glibc build, so --with-deps (Debian
# apt) does NOT apply here — install the runtime shared libs via apk instead and
# let Playwright download the browser. Actually RUNNING Chromium under musl is a
# known-fragile path (glibc-compat is amd64-only above); this layer is authored
# for parity + build correctness and is NOT runtime-verified here.
ARG PLAYWRIGHT_VERSION=1.58.2
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/tau/browser/ms-playwright
RUN apk add --no-cache \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto-emoji && \
    mkdir -p /opt/tau/browser/service /opt/tau/browser/ms-playwright && \
    printf '{"name":"tau-browser","private":true,"dependencies":{"playwright":"%s"}}\n' \
      "${PLAYWRIGHT_VERSION}" > /opt/tau/browser/package.json && \
    bun install --cwd /opt/tau/browser && \
    test "$(jq -r .version /opt/tau/browser/node_modules/playwright/package.json)" = "${PLAYWRIGHT_VERSION}" && \
    bun /opt/tau/browser/node_modules/playwright/cli.js install chromium && \
    chmod -R a+rX /opt/tau/browser

# The tau-browser service + sandbox-verification program — the SAME files
# bootstrap.sh embeds and the machine image COPYs (single source under
# scripts/machine/browser/). No systemd here (Alpine container); startup.sh runs
# the service as a second in-container process (Phase 2).
COPY scripts/machine/browser/tau-browser.js /opt/tau/browser/service/tau-browser.js
COPY scripts/machine/browser/verify-sandbox.js /opt/tau/browser/service/verify-sandbox.js

# Source Nix environment in interactive shells (for devbox)
# The || true ensures the script doesn't fail if nix.sh doesn't exist for the user
RUN echo '[ -f ~/.nix-profile/etc/profile.d/nix.sh ] && . ~/.nix-profile/etc/profile.d/nix.sh || true' >> /etc/profile.d/nix.sh

# Downgrade runc to 1.1.x for sysbox compatibility.
# runc 1.3.x added strict procfs validation via openat2 which fails inside sysbox
# containers because sysbox-fs emulates /proc via FUSE — openat2 detects this as a
# cross-device link and refuses to set sysctls (e.g. net.ipv4.ip_unprivileged_port_start).
# runc 1.1.x doesn't have this check and works correctly under sysbox.
RUN wget -q "https://github.com/opencontainers/runc/releases/download/v1.1.15/runc.${TARGETARCH}" -O /usr/local/bin/runc && \
    chmod +x /usr/local/bin/runc

# Bake the authenticated executor and its named command identity.
COPY apps/core/docker-sandbox/command-identity.json /opt/tau/command-identity.json
COPY packages/k8s-sandbox/package.json /opt/sandbox/package.json
COPY packages/k8s-sandbox/src /opt/sandbox/src
# The executor depends on @ficus/shared as `workspace:*`, which bun can only
# resolve inside a workspace. Make /opt/sandbox that workspace: copy the member
# in and declare it on the executor's own manifest, so server.ts keeps its
# /opt/sandbox/src path and the monorepo's package.json stays the single source.
COPY packages/shared/package.json /opt/sandbox/packages/shared/package.json
COPY packages/shared/src /opt/sandbox/packages/shared/src
RUN addgroup -g 1000 tau && adduser -D -u 1000 -G tau -h /home/tau tau \
    && cd /opt/sandbox \
    && bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.workspaces=["packages/shared"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' \
    && bun install --production \
    && bun -e "require('bun-pty'); require('@ficus/shared/advisory-lock')"

# Create workspace mount point
RUN mkdir -p /workspace /run/tau /run/tau-docker && chown tau:tau /workspace /home/tau
WORKDIR /workspace

# Configure git to trust the workspace directory
RUN git config --global --add safe.directory /workspace && \
    git config --global --add safe.directory '*'

# Route GitHub SSH remotes over port 443 for networks that block outbound TCP/22.
COPY apps/core/docker-sandbox/ssh_config.d/99-github-ssh-over-443.conf /etc/ssh/ssh_config.d/99-github-ssh-over-443.conf

# Copy startup script
COPY apps/core/docker-sandbox/shutdown.sh /usr/local/lib/tau-shutdown.sh
COPY apps/core/docker-sandbox/startup.sh /usr/local/bin/startup.sh
RUN chmod +x /usr/local/bin/startup.sh

# Use custom startup script that:
# - Starts dockerd in background (for sysbox runtime)
# - Skips dockerd if socket already mounted (socket runtime)
# - Keeps container alive with sleep
CMD ["/usr/local/bin/startup.sh"]
