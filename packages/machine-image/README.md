# ficus-machine image

Prebaked OCI image for tau's VM sandbox "machines" on [exe.dev](https://exe.dev):
everything `scripts/machine/bootstrap.sh` installs (bun, multi-user nix, devbox,
Docker engine + rootless extras, nftables, the tau machine scripts) baked into an
exe-compatible image, at the **same pinned versions and paths** bootstrap uses.
Booting a box VM from this image collapses bootstrap from a multi-minute install
to seconds: every idempotent check-then-act step finds its artifact already in
place and skips, and the `/opt/tau/prebaked` marker lets bootstrap fast-path the
install steps entirely (see `scripts/machine/bootstrap.sh`).

The per-box devbox **comfort set is NOT baked** — it is seeded per box at runtime
(`devbox-seed`), keeping this image the base toolchain only.

## Base image decision

`FROM ghcr.io/boldsoftware/exeuntu:latest` — the **published** [exeuntu](https://github.com/boldsoftware/exeuntu)
image, exe.dev's own default VM image.

Rationale:

- It is public on ghcr and pulls anonymously (verified against the registry API:
  tag list + amd64 manifest fetch with an anonymous token; amd64 + arm64 are
  published, ~1.4 GiB compressed for amd64).
- It already carries every exe-compat essential we would otherwise have to
  replicate from the exeuntu Dockerfile: systemd + systemd-sysv as PID 1, the
  `exedev` login user (UID 1000, passwordless sudo, docker group, linger),
  `openssh-server` with baked host keys stripped (regenerated per VM),
  `dbus-user-session`, the `exe.dev/login-user=exedev` label, and exe's init
  wrapper as CMD.
- Boxes provisioned on exe today run on exeuntu, so basing on it keeps the baked
  image behaviorally identical to a bootstrapped stock VM — the fallback path
  (bootstrap on a plain exeuntu VM) and the prebaked path converge on the same
  system.

The `FROM ubuntu:24.04` + replicate-exe-essentials fallback was not needed. One
tradeoff: `latest` is a moving tag (exeuntu rebuilds weekly); CI rebuilds of this
image pick up the refreshed base. Pin a `main-<sha>` tag instead if a base
regression ever needs freezing out.

## What is baked on top (mirrors bootstrap.sh, keep in lockstep)

| Component | Version pin | Path | bootstrap.sh counterpart |
| --- | --- | --- | --- |
| apt base + rootless prereqs | — | (git, curl, unzip, tmux, jq, build-essential, ca-certificates, gnupg, uidmap, dbus-user-session, slirp4netns, fuse-overlayfs) | `install_base_packages` |
| nftables | — | — | `apply_egress_lockdown` (on-demand install, pre-baked here) |
| Docker engine + rootless | — | docker-ce, docker-ce-cli, containerd.io, docker-ce-rootless-extras from Docker's apt repo (replaces exeuntu's docker.io); `docker.service`/`docker.socket` disabled + masked | `install_docker_packages` |
| bun | `1.2.23` | `/opt/tau/bun`, symlinks `/opt/tau/bin/bun` + `/usr/local/bin/bun` | `install_bun` (`BUN_VERSION`) |
| nix (multi-user) | `2.24.9` | `/nix`, daemon units enabled, symlink `/usr/local/bin/nix` | `install_nix` (`NIX_VERSION`) + `link_nix_on_path` |
| devbox | `0.14.0` | `/usr/local/bin/devbox` | `install_devbox` (`DEVBOX_VERSION`) |
| tau dirs + scripts | — | `/opt/tau/{bin,server,archive}`, `bootstrap.sh` + `box-provision.sh` in `/opt/tau/bin/` | `make_dirs` / manager push |
| prebaked marker | — | `/opt/tau/prebaked` (JSON: baked pins) | read by bootstrap's fast-path |

`/opt/tau/manifest.json` is deliberately **not** baked — bootstrap writes it
per-machine with the caller's `--version` hash.

## Building

exe VMs are x86_64, so the image **must** be built for `linux/amd64`. From the
**repo root** (the Dockerfile COPYs `scripts/machine/*`):

```sh
docker buildx build --platform linux/amd64 \
  -f packages/machine-image/Dockerfile \
  -t ghcr.io/ficushq/ficus-machine:latest .
```

## Publishing (ghcr.io/ficushq/ficus-machine)

CI builds and pushes on main (see `.github/workflows/publish-images.yml`):

```sh
docker push ghcr.io/ficushq/ficus-machine:latest
```

**One-time manual step:** after the first push, set the ghcr package to
**public** (GitHub → ficushq org → Packages → `ficus-machine` → Package settings
→ Danger Zone → Change visibility → Public). Package visibility is independent
of source repository visibility. Public is required so exe.dev pulls the image
without `--registry-auth`.

## Using

```sh
exe new --image=ghcr.io/ficushq/ficus-machine:latest
```

The exe provider passes this via `FICUS_EXE_MACHINE_IMAGE`
(default `ghcr.io/ficushq/ficus-machine:latest`).

On a VM booted from this image, bootstrap.sh detects `/opt/tau/prebaked` and
skips the install steps (bun/nix/devbox/apt), doing only per-boot work — the
manifest write and the capabilities probe — so bootstrap completes in seconds.
On a non-prebaked machine (BYO-SSH Ubuntu) bootstrap still performs the full
idempotent install; the marker is an optimization, never a dependency.
