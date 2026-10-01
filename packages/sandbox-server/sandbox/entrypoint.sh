#!/bin/bash
# Tool Executor Entrypoint
#
# Squad boxes bake their heavy devbox toolchain into the image and re-realize it
# from the local /nix store at startup. Agent (light) boxes carry their comfort
# set on PATH via the image's global nix profile and ship an EMPTY devbox.json,
# so `devbox install` is skipped entirely on cold start (see devbox_has_packages
# below) — agents only pay for `devbox install` once they `devbox add` a package.

set -e

# Shared PVC mounts are also read/written by Ficus Core. In local k3d that
# usually means container root and host user share the same underlying files.
# Keep new sandbox-created files group-writable when FICUS_SHARED_GID is provided
# by Core; this is harmless on CSI drivers that ignore chmod/chgrp failures.
umask "${FICUS_SANDBOX_UMASK:-0002}"

# Profiling helper: prof <label> <start-ns>. Emits "[profile] <label> <ms>ms".
prof() { echo "[profile] $1 $(( ($(date +%s%N) - $2) / 1000000 ))ms"; }

# True when a devbox.json declares at least one package. An empty package set
# (the agent box's default) means there is nothing for `devbox install` to
# realize, so we skip the slow Nix evaluation entirely — the agent's comfort
# tools are already on PATH via the image's global nix profile.
devbox_has_packages() {
  local f="$1"
  [ -f "$f" ] || return 1
  local n
  n=$(jq '((.packages // []) | length)' "$f" 2>/dev/null || echo 0)
  [ "${n:-0}" -gt 0 ]
}

normalize_shared_mount() {
  local dir="$1"
  [ -d "$dir" ] || return 0

  # Keep startup bounded: large/restored workspaces can contain hundreds of
  # thousands of files, so recursively normalizing on every container start can
  # block the sandbox HTTP server and leave the pod NotReady/"Starting".
  if [ -n "${FICUS_SHARED_GID:-}" ]; then
    chgrp "$FICUS_SHARED_GID" "$dir" 2>/dev/null || true
  fi
  chmod g+rwX "$dir" 2>/dev/null || true
  chmod g+s "$dir" 2>/dev/null || true

  # Optional one-time recursive normalization for existing files. This runs in
  # the background and writes a marker so restarts do not repeat expensive work.
  if [ "${FICUS_RECURSIVE_PERMISSION_NORMALIZE:-false}" = "true" ]; then
    local marker="$dir/.ficus-permissions-normalized-v1"
    if [ ! -e "$marker" ]; then
      (
        if [ -n "${FICUS_SHARED_GID:-}" ]; then
          chgrp -R "$FICUS_SHARED_GID" "$dir" 2>/dev/null || true
        fi
        chmod -R g+rwX "$dir" 2>/dev/null || true
        find "$dir" -type d -exec chmod g+s {} + 2>/dev/null || true
        touch "$marker" 2>/dev/null || true
      ) &
    fi
  fi
}

normalize_shared_mount /workspace
normalize_shared_mount /var/lib/ficus/ssh-source
normalize_shared_mount /nix-cache

# Source Nix environment
if [ -f ~/.nix-profile/etc/profile.d/nix.sh ]; then
  . ~/.nix-profile/etc/profile.d/nix.sh
elif [ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

# Shared runtime env for the sandbox server and child commands.
# This gives spawned bash commands sane defaults even before devboxReady.
if [ -f /opt/sandbox/runtime-env.sh ]; then
  . /opt/sandbox/runtime-env.sh
fi

# ── SSH key sync ─────────────────────────────────────────────────────────────
# The host API writes squad SSH keys to a shared PVC subdirectory, mounted
# inside the pod at $SSH_SOURCE. The host process is not root, so that mount
# cannot have the strict root:root 700 perms OpenSSH's client requires.
# We mirror $SSH_SOURCE into a container-private $SSH_DEST and own the perms
# there. Any chown/chmod we do is on $SSH_DEST only — never on the shared mount,
# so the host API keeps full read/write access via its normal Unix uid/gid.
SSH_SOURCE=/var/lib/ficus/ssh-source
SSH_DEST=/root/.ssh

mkdir -p "$SSH_DEST"

sync_ssh_keys() {
  if [ -d "$SSH_SOURCE" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete "$SSH_SOURCE/" "$SSH_DEST/" 2>/dev/null || true
    else
      # Fallback: emulate rsync --delete with cp + targeted removal.
      ( cd "$SSH_DEST" && for f in $(ls -A 2>/dev/null); do
          [ -e "$SSH_SOURCE/$f" ] || rm -rf -- "$f"
        done )
      cp -a "$SSH_SOURCE/." "$SSH_DEST/" 2>/dev/null || true
    fi
  fi
  chown -R root:root "$SSH_DEST" 2>/dev/null || true
  chmod 700 "$SSH_DEST" 2>/dev/null || true
  find "$SSH_DEST" -type f ! -name "*.pub" ! -name "known_hosts" ! -name "config" -exec chmod 600 {} \; 2>/dev/null || true
  find "$SSH_DEST" -type f \( -name "*.pub" -o -name "known_hosts" \) -exec chmod 644 {} \; 2>/dev/null || true
  [ -f "$SSH_DEST/config" ] && chmod 600 "$SSH_DEST/config" 2>/dev/null || true
}
sync_ssh_keys

# Mirror new/changed/deleted keys from the source dir into /root/.ssh (30s poll).
(
  while true; do
    sleep 30
    sync_ssh_keys
  done
) &

# ── Git credentials ──────────────────────────────────────────────────────────
if [ -n "$GITHUB_TOKEN" ]; then
  echo "[entrypoint] Configuring git credential helper..."
  git config --global credential.helper github-token
fi

# ── Git config ───────────────────────────────────────────────────────────────
[ -n "$GIT_USER_NAME" ] && git config --global user.name "$GIT_USER_NAME"
[ -n "$GIT_USER_EMAIL" ] && git config --global user.email "$GIT_USER_EMAIL"

# ── Nix cache helpers ────────────────────────────────────────────────────────
# Persist squad-specific nix packages as a single tarball on EFS.
# Base image packages are in /nix-base-manifest.txt; only the delta is cached.
NIX_CACHE_TAR="/nix-cache/nix-delta.tar.zst"
NIX_CACHE_AVAILABLE=false
if [ -d /nix-cache ] && [ -f /nix-base-manifest.txt ]; then
  NIX_CACHE_AVAILABLE=true
fi

restore_nix_cache() {
  if [ "$NIX_CACHE_AVAILABLE" = true ] && [ -f "$NIX_CACHE_TAR" ]; then
    echo "[nix-cache] Restoring cached nix packages..."
    local start=$(date +%s)
    tar -I pzstd -xf "$NIX_CACHE_TAR" -C / 2>/dev/null || {
      echo "[nix-cache] Warning: cache restore failed (removing corrupt cache, will reinstall)"
      # Drop the unusable tarball + db export so the next save regenerates a
      # clean cache instead of retrying a corrupt one on every restart.
      rm -f "$NIX_CACHE_TAR" /nix-cache/nix-db-export.txt 2>/dev/null || true
      return 1
    }
    # Register restored paths with nix db
    nix-store --load-db < /nix-cache/nix-db-export.txt 2>/dev/null || true
    local elapsed=$(( $(date +%s) - start ))
    echo "[nix-cache] Restored in ${elapsed}s"
  fi
}

save_nix_cache() {
  if [ "$NIX_CACHE_AVAILABLE" = true ]; then
    # Find paths not in the base image
    local delta_paths
    delta_paths=$(comm -23 <(ls /nix/store | sort) <(cat /nix-base-manifest.txt) | sed 's|^|/nix/store/|')
    if [ -z "$delta_paths" ]; then
      echo "[nix-cache] No new packages to cache"
      return 0
    fi
    local count=$(echo "$delta_paths" | wc -l | tr -d ' ')
    # Skip save if store hasn't changed since last snapshot (restore or save)
    local current_count=$(ls /nix/store | wc -l)
    if [ "$current_count" = "$NIX_STORE_SNAPSHOT" ] && [ -f "$NIX_CACHE_TAR" ]; then
      echo "[nix-cache] No changes since last snapshot (${count} cached paths), skipping save"
      return 0
    fi
    echo "[nix-cache] Saving nix package cache..."
    local start=$(date +%s)
    # Export nix db entries for delta paths
    echo "$delta_paths" | xargs nix-store --dump-db > /nix-cache/nix-db-export.txt.tmp 2>/dev/null || true
    mv /nix-cache/nix-db-export.txt.tmp /nix-cache/nix-db-export.txt 2>/dev/null || true
    # Create tarball (write to temp file then rename for atomicity)
    # Don't suppress tar/pzstd stderr: silently swallowing it is how a
    # truncated/corrupt tarball can get committed without warning.
    echo "$delta_paths" | tar -I pzstd -cf "$NIX_CACHE_TAR.tmp" -T - || {
      echo "[nix-cache] Warning: cache save failed"
      rm -f "$NIX_CACHE_TAR.tmp"
      return 1
    }
    mv "$NIX_CACHE_TAR.tmp" "$NIX_CACHE_TAR"
    # Update snapshot so subsequent saves (e.g. SIGTERM) skip if nothing changed
    NIX_STORE_SNAPSHOT=$(ls /nix/store | wc -l)
    local size=$(du -sh "$NIX_CACHE_TAR" | cut -f1)
    local elapsed=$(( $(date +%s) - start ))
    echo "[nix-cache] Saved ${count} paths (${size}) in ${elapsed}s"
  fi
}

# ── Workspace devbox ─────────────────────────────────────────────────────────
# Agent (light) boxes keep their own minimal devbox in $FICUS_DEVBOX_DIR (/private
# for squad members); squad boxes use $WORKSPACE_PATH. Agent boxes seed the
# minimal devbox.agent.json template; squad boxes seed the full devbox.json.
WS="${FICUS_DEVBOX_DIR:-${WORKSPACE_PATH:-/workspace}}"
DEFAULT_DEVBOX=/opt/ficus/defaults/devbox.json
if [ "${FICUS_SANDBOX_ROLE:-squad}" = "agent" ] && [ -f /opt/ficus/defaults/devbox.agent.json ]; then
  DEFAULT_DEVBOX=/opt/ficus/defaults/devbox.agent.json
fi
mkdir -p "$WS"
if [ ! -f "$WS/devbox.json" ] && [ -f "$DEFAULT_DEVBOX" ]; then
  echo "[entrypoint] Seeding default devbox.json into $WS..."
  cp "$DEFAULT_DEVBOX" "$WS/devbox.json"
elif [ -f "$WS/devbox.json" ] && [ -f "$DEFAULT_DEVBOX" ]; then
  # Merge new packages from default into workspace devbox.json.
  # Only adds packages not already present (by name, ignoring version).
  # Non-fatal — don't break sandbox startup over devbox.json merge.
  (
    MERGED=$(jq -s '
      .[0] as $ws | .[1] as $default |
      ($ws.packages | map(split("@")[0])) as $existing_names |
      ($default.packages | map(select(split("@")[0] as $name | $existing_names | index($name) | not))) as $new |
      if ($new | length) > 0
      then $ws | .packages += $new
      else $ws
      end
    ' "$WS/devbox.json" "$DEFAULT_DEVBOX" 2>/dev/null) || true
    if [ -n "$MERGED" ] && [ "$MERGED" != "$(cat "$WS/devbox.json")" ]; then
      echo "$MERGED" > "$WS/devbox.json"
      echo "[entrypoint] Updated devbox.json with new default packages"
    fi
  ) || echo "[entrypoint] Warning: devbox.json merge failed (non-fatal)"
fi

# Seed the baked devbox.lock so the workspace `devbox install` resolves to the
# SAME /nix/store paths that were baked into the image. Without it, the floating
# @latest pins re-resolve to a different toolchain closure at runtime, which then
# inflates the nix-cache delta to ~850MB (re-saved/restored every cold start).
# Only seed when absent — never clobber a workspace's own evolved lock.
DEFAULT_LOCK="${DEFAULT_DEVBOX%.json}.lock"
if [ ! -f "$WS/devbox.lock" ] && [ -f "$DEFAULT_LOCK" ]; then
  echo "[entrypoint] Seeding baked devbox.lock into $WS..."
  # Non-fatal: never let a seed write (read-only $WS, ENOSPC, CSI quirk) abort
  # startup under `set -e` — a missing lock only means devbox re-resolves, it
  # must not gate pod readiness.
  cp "$DEFAULT_LOCK" "$WS/devbox.lock" || echo "[entrypoint] Warning: devbox.lock seed failed (non-fatal)"
fi

# Restore cached nix packages + realize devbox in the BACKGROUND so pod-readiness
# (the /healthz startup probe) is NEVER gated on slow boot work. A squad box can
# spend ~20s extracting its nix delta cache; doing that inline here would block
# the server from starting and hold the pod NotReady the whole time. The server
# starts immediately below; devboxReady flips only once this finishes.
# Note: .tau/.bashrc is created by the sandbox manager (ensureBashrc) when
# connecting to the pod, not here — keeps content in sync with Docker manager.
# Squad boxes (and any agent that has `devbox add`ed a package) realize their
# devbox here; an empty agent devbox.json short-circuits to a true no-op.
(
  # Restore cached nix packages before devbox install. Non-fatal: a failed/corrupt
  # restore is recoverable (devbox install rebuilds the packages below). Agent
  # (light) boxes have no nix-cache mount — skip restore entirely.
  if [ "${FICUS_SANDBOX_ROLE:-squad}" != "agent" ]; then
    _t=$(date +%s%N); restore_nix_cache || true; prof nix-cache-restore "$_t"
  fi

  # Snapshot store state after restore — used to detect if devbox install added anything new
  NIX_STORE_SNAPSHOT=$(ls /nix/store | wc -l)

  if [ -f "$WS/devbox.json" ] && devbox_has_packages "$WS/devbox.json"; then
    echo "[background] Running devbox install..."
    _t=$(date +%s%N); (cd "$WS" && devbox install 2>&1) || echo "[background] Warning: devbox install failed"; prof devbox-install "$_t"
    echo "[background] Initializing devbox shell environment..."
    eval "$(cd "$WS" && devbox shellenv --init-hook 2>/dev/null)" >/dev/null 2>&1 || true
    [ -f /opt/sandbox/runtime-env.sh ] && . /opt/sandbox/runtime-env.sh
  else
    echo "[background] No devbox packages in $WS — skipping devbox install (comfort tools are on PATH via the global nix profile)."
  fi

  # Save nix cache after install (captures squad-specific packages).
  # Agent (light) boxes have no nix-cache mount — skip the save.
  if [ "${FICUS_SANDBOX_ROLE:-squad}" != "agent" ]; then save_nix_cache; fi

  if [ -x "$WS/.tau/setup.sh" ]; then
    echo "[background] Running workspace setup script..."
    (cd "$WS" && .tau/setup.sh) || true
  fi

  # Signal devbox ready to the sandbox server (retry until server is up)
  for i in $(seq 1 30); do
    if curl -sf -X POST http://localhost:50051/devbox-ready >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  echo "[background] Setup complete."
) &

# ── Graceful shutdown: save nix cache on SIGTERM ─────────────────────────────
# Catches idle-timeout, manual stop, and scale-down. Allows the background
# bun process to exit cleanly after we save.
shutdown_handler() {
  echo "[entrypoint] SIGTERM received, saving nix cache before exit..."
  save_nix_cache
  # Forward SIGTERM to the bun server (PID 1's child)
  kill -TERM "$BUN_PID" 2>/dev/null
  wait "$BUN_PID" 2>/dev/null
  exit 0
}

echo "[entrypoint] Starting sandbox..."
bun run /opt/sandbox/src/server.ts &
BUN_PID=$!
trap shutdown_handler SIGTERM
wait "$BUN_PID"
