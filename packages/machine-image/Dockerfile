# ficus-machine: prebaked box-VM image for exe.dev
# ===============================================
# exeuntu (exe.dev's default, exe-compatible Ubuntu 24.04 + systemd + exedev
# user) with everything scripts/machine/bootstrap.sh installs baked on top, at
# the SAME pinned versions and paths — so a first bootstrap on a VM booted from
# this image hits every idempotent skip and completes in seconds instead of
# minutes. /opt/ficus/prebaked marks the image so bootstrap can fast-path.
#
# KEEP IN LOCKSTEP with scripts/machine/bootstrap.sh: the ARG pins below should
# match its BUN_VERSION / NIX_VERSION / DEVBOX_VERSION, and every install step
# here mirrors one of its install_* functions (referenced per step). A drift does
# NOT trigger a boot-time reinstall — bootstrap always boots on the BAKED tooling
# (a nix reinstall over the baked /nix would brick the boot) and just logs a
# warning to rebake. Change a pin by rebuilding this image, not at boot.
#
# Build (MUST be linux/amd64 — exe VMs are x86_64), from the REPO ROOT
# (the COPY below reaches into scripts/machine/):
#   docker buildx build --platform linux/amd64 \
#     -f packages/machine-image/Dockerfile \
#     -t ghcr.io/ficushq/ficus-machine:latest .

# Base: the PUBLISHED exeuntu image (public on ghcr, pulls anonymously —
# verified). Already provides: systemd + systemd-sysv init, the `exedev`
# login user (UID 1000, passwordless sudo, docker group, linger), sshd with
# host keys stripped (regenerated per-VM), dbus-user-session, git/curl/unzip/
# build-essential/etc, and CMD /usr/local/bin/init + the exe.dev labels.
FROM ghcr.io/boldsoftware/exeuntu:latest

# Pins — should match scripts/machine/bootstrap.sh (BUN_VERSION / NIX_VERSION /
# DEVBOX_VERSION); on drift bootstrap still boots on the baked tooling and warns
# to rebake (it never reinstalls over a prebaked image — see the header note).
ARG BUN_VERSION=1.2.23
ARG NIX_VERSION=2.24.9
ARG DEVBOX_VERSION=0.14.0
ARG PLAYWRIGHT_VERSION=1.58.2

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]
USER root

# --- bootstrap.sh install_base_packages + nftables ---------------------------
# Same list, same --no-install-recommends. Most are already in exeuntu; the
# rootless-docker prereqs (uidmap, slirp4netns, fuse-overlayfs) and tmux/gnupg/
# nftables are the real additions. nftables is baked for the --egress-lockdown
# path (bootstrap otherwise apt-installs it at apply time).
RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends \
      git \
      curl \
      unzip \
      tmux \
      jq \
      build-essential \
      ca-certificates \
      gnupg \
      uidmap \
      dbus-user-session \
      slirp4netns \
      fuse-overlayfs \
      nftables && \
    rm -rf /var/lib/apt/lists/*

# --- bootstrap.sh make_dirs (+ box-provision.sh's archive dir) ---------------
RUN mkdir -p /opt/ficus/bin /opt/ficus/server /opt/ficus/archive

# --- bootstrap.sh install_docker_packages ------------------------------------
# Docker's official apt repo: docker-ce-rootless-extras (dockerd-rootless.sh,
# dockerd-rootless-setuptool.sh, rootlesskit — what per-box rootless dockerd
# needs) is not in Ubuntu's repos. This REPLACES exeuntu's docker.io with
# docker-ce (apt resolves the conflict), exactly what bootstrap does on a
# stock exeuntu VM. Then close the root hole the same way bootstrap does:
# disable AND mask the rootful daemon + socket — every box runs its OWN
# rootless dockerd as a systemd --user service (box-provision.sh); a shared
# rootful dockerd would be root-equivalent for every box user.
RUN export DEBIAN_FRONTEND=noninteractive && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    arch="$(dpkg --print-architecture)" && \
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME}")" && \
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
      "${arch}" "${codename}" > /etc/apt/sources.list.d/docker.list && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-ce-rootless-extras && \
    systemctl disable docker.service docker.socket || true && \
    systemctl mask docker.service docker.socket && \
    rm -rf /var/lib/apt/lists/*

# --- bootstrap.sh install_bun -------------------------------------------------
# Official installer, pinned tag, system-wide into /opt/ficus/bun (NOT a user
# home). /opt/ficus/bin/bun is the stable path box-provision's systemd unit
# ExecStart references; /usr/local/bin/bun additionally puts bun on every
# user's PATH (image nicety — bootstrap manages only /opt/ficus/bin/bun).
RUN curl -fsSL https://bun.sh/install \
      | env BUN_INSTALL=/opt/ficus/bun bash -s "bun-v${BUN_VERSION}" && \
    ln -sf /opt/ficus/bun/bin/bun /opt/ficus/bin/bun && \
    ln -sf /opt/ficus/bun/bin/bun /usr/local/bin/bun && \
    [ "$(/opt/ficus/bin/bun --version)" = "${BUN_VERSION}" ]

# --- bootstrap.sh install_nix + link_nix_on_path ------------------------------
# Multi-user (daemon-mode) nix: one VM hosts MANY unprivileged box users, and
# only a root-owned /nix/store with socket-mediated writes serves them all.
# The official pinned installer runs headless in a docker build fine (no TTY
# => auto-confirms) EXCEPT for one step: setup_default_profile installs the
# bootstrapping nix into the default profile via `nix-env -i`, which builds a
# "user environment" derivation — nix installs a syscall (seccomp-BPF) filter
# around every build, and loading that filter under QEMU cross-arch emulation
# (building linux/amd64 on an arm64 host) fails with "unable to load seccomp
# BPF program: Invalid argument" — a well-documented nix-under-QEMU limitation
# (github.com/DeterminateSystems/nix-installer#324/#851/#1106), NOT something
# a real (non-emulated) VM or a native-amd64 CI runner ever hits. Scope
# `NIX_CONFIG="filter-syscalls = false"` to just this RUN's shell (an env var
# read at nix startup, never written to disk) to work around it — this bakes
# NO config divergence from what install_nix produces on a bare VM: the
# installer's own place_nix_configuration step still writes the real
# /etc/nix/nix.conf (build-users-group=nixbld) exactly as on a real machine.
# `/run/systemd/system` is also absent in a docker build, so the installer's
# poly_configure_nix_daemon_service step (normally the last thing it does)
# self-skips with a "configure your init manually" reminder instead of
# erroring — we replicate it by hand: tmpfiles config + `systemctl link` the
# service + enable the socket. Both act via systemd's documented "offline"
# unit-enablement fallback (direct symlink manipulation) when no systemd
# manager is reachable, so they succeed at build time with no daemon running;
# first real boot then socket-activates nix-daemon and `devbox install` just
# works. /usr/local/bin/nix mirrors bootstrap's link_nix_on_path: the
# sandbox-server runs box commands in NON-login shells, which never source
# nix's profile.d.
RUN export NIX_CONFIG="filter-syscalls = false" && \
    curl -fsSL "https://releases.nixos.org/nix/nix-${NIX_VERSION}/install" \
      | sh -s -- --daemon --yes --no-channel-add && \
    ln -sfn /nix/var/nix/profiles/default/lib/tmpfiles.d/nix-daemon.conf \
      /etc/tmpfiles.d/nix-daemon.conf && \
    systemctl link /nix/var/nix/profiles/default/lib/systemd/system/nix-daemon.service && \
    systemctl enable /nix/var/nix/profiles/default/lib/systemd/system/nix-daemon.socket && \
    ln -sf /nix/var/nix/profiles/default/bin/nix /usr/local/bin/nix && \
    /usr/local/bin/nix --version | grep -q "${NIX_VERSION}"

# --- bootstrap.sh install_devbox ----------------------------------------------
# The exact pinned release binary, straight onto every box user's PATH — no
# per-user runtime download or ~/.cache priming.
RUN arch="$(dpkg --print-architecture)" && \
    tmp="$(mktemp -d)" && \
    curl -fsSL "https://github.com/jetify-com/devbox/releases/download/${DEVBOX_VERSION}/devbox_${DEVBOX_VERSION}_linux_${arch}.tar.gz" \
      -o "${tmp}/devbox.tar.gz" && \
    tar -xzf "${tmp}/devbox.tar.gz" -C "${tmp}" && \
    install -m 0755 "${tmp}/devbox" /usr/local/bin/devbox && \
    rm -rf "${tmp}" && \
    /usr/local/bin/devbox version | grep -q "${DEVBOX_VERSION}"

# --- bootstrap.sh install_browser ---------------------------------------------
# KEEP IN LOCKSTEP with scripts/machine/bootstrap.sh install_browser (same
# PLAYWRIGHT_VERSION — asserted by bootstrap.test.ts — same /opt/ficus/browser
# layout, same ficus-browser user/unit/AppArmor profile/service program). ONE
# shared Chromium per machine, root-owned + world-readable, driven by the
# unprivileged ficus-browser user over a group-restricted socket
# (browser-tools-in-sandbox spec §4.1/§4.2). The Chromium sandbox is a HARD GATE
# verified per-boot by bootstrap's verify_browser (which also loads the AppArmor
# profile into the running kernel, writes the host-specific MemoryHigh drop-in,
# and starts the service) — none of that is baked here. The service PROGRAM is
# the real Phase 2 implementation: one BrowserContext per authenticated box,
# token auth, per-box/machine caps (scripts/machine/browser/ficus-browser.js).
RUN groupadd --system ficus-browser && \
    useradd --system --gid ficus-browser --home-dir /opt/ficus/browser/home \
      --create-home --shell /usr/sbin/nologin ficus-browser && \
    mkdir -p /opt/ficus/browser/service /opt/ficus/browser/ms-playwright && \
    printf '{"name":"ficus-browser","private":true,"dependencies":{"playwright":"%s"}}\n' \
      "${PLAYWRIGHT_VERSION}" > /opt/ficus/browser/package.json && \
    export DEBIAN_FRONTEND=noninteractive && \
    export PLAYWRIGHT_BROWSERS_PATH=/opt/ficus/browser/ms-playwright && \
    /opt/ficus/bin/bun install --cwd /opt/ficus/browser && \
    [ "$(jq -r .version /opt/ficus/browser/node_modules/playwright/package.json)" = "${PLAYWRIGHT_VERSION}" ] && \
    /opt/ficus/bin/bun /opt/ficus/browser/node_modules/playwright/cli.js install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*

# The service program, the sandbox-verification program, the AppArmor
# profile, and the SYSTEM unit are the SAME files bootstrap.sh embeds inline
# (byte-identical, asserted by bootstrap.test.ts) — COPY them here rather than
# duplicate. The unit is NOT enabled here; verify_browser enables + starts it and
# writes the host-specific MemoryHigh drop-in per-boot. apparmor.service loads
# the profile at boot; verify_browser also reloads it.
COPY scripts/machine/browser/ficus-browser.js /opt/ficus/browser/service/ficus-browser.js
COPY scripts/machine/browser/verify-sandbox.js /opt/ficus/browser/service/verify-sandbox.js
COPY scripts/machine/browser/ficus-browser-chromium.apparmor /etc/apparmor.d/ficus-browser-chromium
COPY scripts/machine/browser/ficus-browser.service /etc/systemd/system/ficus-browser.service

# Root-owned + world-readable browser tree (box users read the binaries); the
# service user's HOME stays private + writable.
RUN chown -R root:root /opt/ficus/browser && \
    chmod -R a+rX /opt/ficus/browser && \
    chown -R ficus-browser:ficus-browser /opt/ficus/browser/home && \
    chmod 0700 /opt/ficus/browser/home

# --- Ficus scripts + prebaked marker --------------------------------------------
# Bake the machine scripts where the manager expects them. bootstrap.sh's
# prebaked fast-path (and humans debugging a VM) read /opt/ficus/prebaked to
# know the toolchain above is already installed; the JSON records the pins it
# was baked at. NOTE: /opt/ficus/manifest.json is NOT baked — bootstrap writes
# it per-machine with the caller's --version hash.
COPY scripts/machine/bootstrap.sh scripts/machine/box-provision.sh /opt/ficus/bin/
RUN chmod 0755 /opt/ficus/bin/bootstrap.sh /opt/ficus/bin/box-provision.sh && \
    printf '{"bunVersion":"%s","nixVersion":"%s","devboxVersion":"%s","playwrightVersion":"%s"}\n' \
      "${BUN_VERSION}" "${NIX_VERSION}" "${DEVBOX_VERSION}" "${PLAYWRIGHT_VERSION}" > /opt/ficus/prebaked

# Inherited from exeuntu, restated so the contract survives a base change:
# exe.dev SSHes into this user.
LABEL "exe.dev/login-user"="exedev"
