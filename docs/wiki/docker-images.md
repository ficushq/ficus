# Docker Images

Ficus uses two Docker images: **ficus-core** for the API server, worker, and CLI, and **ficus-sandbox** for agent sandbox pods with devbox/nix development environments.

## ficus-core

**File:** `Dockerfile` (repo root)  
**Build:** `bun run core:build` or `docker build -t ficus-core:latest .`

Multi-stage build producing a single image that runs as any of 3 services via CMD override.

### Build Stages

**Stage 1 — Builder** (`oven/bun:1`):

- Copies `package.json` files first for layer caching
- Installs all dependencies (including devDependencies)
- Copies source and builds core + CLI in parallel (`bun run build:core & bun run build:cli & wait`)
- Web is **not** built here — served via CloudFront/S3

**Stage 2 — Production** (`oven/bun:1-slim`):

- Installs runtime system packages: `ca-certificates`, `curl`, `git`, `openssh-client`
- Downloads Amazon RDS CA bundle for SSL connections
- Production-only `bun install`
- Copies built artifacts from builder
- Symlinks CLI to `/usr/local/bin/ficus`

### Run Modes

Each K8s Deployment overrides the CMD to run a different service:

| Service              | Command                            | Port |
| -------------------- | ---------------------------------- | ---- |
| API server (default) | `bun run apps/core/dist/index.js`  | 3000 |
| Worker               | `bun run apps/core/dist/worker.js` | —    |

### What's Included

- API server and worker (Hono/Bun)
- CLI (`ficus` on PATH)
- Drizzle migrations (`apps/core/drizzle/`)
- openssh-client for git memory sync
- RDS CA bundle for SSL database connections

---

## ficus-sandbox

**File:** `packages/sandbox-server/Dockerfile`  
**Build:** `bun run sandbox:build:k8s` or `docker build -t ficus-sandbox:latest -f packages/sandbox-server/Dockerfile .`

Single-stage build from `ubuntu:24.04` with nix, devbox, and all development packages baked in.

### What's Installed

| Layer                 | Contents                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| System packages       | bash, git, ssh, curl, wget, sudo, docker.io, unzip, xz-utils                                                     |
| Nix                   | Single-user mode, filter-syscalls disabled (for sysbox), flakes enabled                                          |
| Devbox                | Installed from jetpack.io, default `devbox.json` pre-installed                                                   |
| Devbox packages       | All packages from `packages/sandbox-server/sandbox/devbox.json` baked into `/nix/store` (~1.2GB)                 |
| Bun                   | Installed to `/usr/local`                                                                                        |
| Ficus CLI             | Not bundled; Core stages `cli/ficus.js` into the shared core-data volume and mounts it at `/usr/local/bin/ficus` |
| Tool executor         | HTTP service at `/opt/sandbox/` using bun-pty for shell sessions                                                 |
| Git credential helper | `git-credential-github-token` for repo access                                                                    |

### Runtime

- **Entrypoint:** `packages/sandbox-server/sandbox/entrypoint.sh` — handles sysbox user namespace setup, SSH key permissions for PVC-mounted keys
- **Runtime class:** `sysbox-runc` for secure container isolation
- **Healthcheck:** `GET /healthz` on port 50051
- **Directories:** `/workspace` (code), `/memory` (memory files), `/home/ficus`
- **Ficus CLI:** mounted read-only from the shared core-data PVC at `/usr/local/bin/ficus`; rebuild the CLI and recreate pods after CLI-only changes, without rebuilding the sandbox image.

### Nix/Devbox Design Decision

The image bakes all devbox packages into the nix store at build time. This adds ~1.2GB to the image but eliminates a 5+ minute download on every pod start. The evolution:

1. **EFS mount for /nix/store** — too slow, NFS can't handle nix's many small files
2. **Bake into image** — fast startup but large image
3. **Seed from image at runtime** — copy /nix-seed to EFS on first boot, slow and fragile
4. **Final: bake packages into image** — accepted the image size tradeoff for reliable instant startup

---

## Build Commands

```bash
bun run core:build         # Build ficus-core image
bun run sandbox:build:k8s  # Build ficus-sandbox image
```

Both should target `linux/amd64` for K8s deployment:

```bash
docker build --platform linux/amd64 -t ficus-core:latest .
docker build --platform linux/amd64 -t ficus-sandbox:latest -f packages/sandbox-server/Dockerfile .
```

## Layer Caching

Both Dockerfiles are optimized for layer caching:

1. `package.json` + `bun.lock` copied first → dependency install layer cached unless lockfile changes
2. Source code copied after → only rebuild layers change on code updates
3. Core Dockerfile uses `--ignore-scripts` to skip unnecessary postinstall hooks

## Pushing to ECR

```bash
./scripts/ecr-login.sh              # Authenticate (12hr token)
./scripts/ecr-push-images.sh        # Build and push both images
./scripts/ecr-push-images.sh --core-only     # Just core
./scripts/ecr-push-images.sh --sandbox-only  # Just sandbox
```

See [CI/CD](ci-cd.md) for automated builds via GitHub Actions.
