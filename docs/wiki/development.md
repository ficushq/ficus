# Developing Ficus

Working **on** ficus, not just running it. Installing ficus is a different job —
[docs/wiki/setup.md](setup.md#local-setup) covers that, and `bun run setup` gets a
checkout from nothing to a running instance in one command. Everything here
assumes that already happened.

For code conventions (Bun, monorepo layout, React Query, migrations), read
[`AGENTS.md`](../../AGENTS.md); for how the system fits together, read
[`README.md`](README.md).

## Prerequisites

Use Node.js 24 LTS (minimum 22.19.0) for Node-based build tools, including Astro and Pi. Bun remains the package manager and application runtime.

Beyond what setup installs, developing ficus wants:

- [Bun](https://bun.sh) — the runtime and package manager (`curl -fsSL https://bun.sh/install | bash`). The pinned version is in `.bun-version`; `bun upgrade` if preflight complains.
- [Docker](https://docs.docker.com/get-docker/) — for the PostgreSQL containers, the `docker-socket`/`docker-sysbox` runtimes, and k3d.
- [GitHub CLI](https://cli.github.com/) — `gh auth login`, used by the git identity and signing setup below and by agents' GitHub flows.
- [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — optional on the host; agents can also use provider credentials configured in the UI.

PM2 ships as a dev dependency, so `bunx pm2 …` works without a global
installation when you explicitly use that supervisor. Fresh local setup
defaults to launchd on macOS and systemd-user on Linux; existing installations
keep their recorded supervisor.

### Git identity

Set the global Git user name and email to match the authenticated GitHub
account, so commits from this machine (and from agents running on it) attribute
correctly:

```bash
# Pull username and noreply email from GitHub
GH_USER=$(gh api user --jq .login)
git config --global user.name "$GH_USER"
git config --global user.email "${GH_USER}@users.noreply.github.com"
```

Verify:

```bash
git config --global user.name
git config --global user.email
```

### Commit signing

All commits should be signed so they show as **Verified** on GitHub. Use
SSH-based signing:

```bash
# Generate an SSH signing key (no passphrase)
ssh-keygen -t ed25519 -C "$(git config user.email)" -f ~/.ssh/signing_key -N ""

# Upload the key to GitHub as a signing key
gh ssh-key add ~/.ssh/signing_key.pub --title "commit-signing-key" --type signing

# Configure Git to sign all commits and tags with SSH
git config --global commit.gpgsign true
git config --global tag.gpgsign true
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/signing_key.pub

# Set up allowed signers for local verification
mkdir -p ~/.config/git
echo "$(git config user.email) $(cat ~/.ssh/signing_key.pub)" > ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

Verify the setup:

```bash
git config --global --list | grep -E '(sign|gpg)'
# Should show commit.gpgsign=true, gpg.format=ssh, etc.
```

## The dev loop

`bun run setup` builds Core and the web app, then starts the API and worker
under the installation's recorded supervisor. Use `ficus server status` to see
that supervisor and the local instance being managed.

For hot-reload development, stop those installed services before starting
source processes on the same ports. Keep the instance's configured PostgreSQL
running. `ficus server stop` stops the API and worker without deleting or
stopping their database:

```bash
ficus server stop
bun run dev:core        # terminal 1: API + worker, both in watch mode
```

In a second terminal at the repository root:

```bash
bun run dev:web         # Vite, with the dev access-token wrapper
```

The default browser address is `http://localhost:5173`; the default API address
is `http://localhost:3000`. Core's watch commands read the checkout's `.env`.
Vite's default local proxy points at port 3000, so an instance using another
API port needs an explicitly configured backend rather than assuming the
proxy follows `PORT`.

The root `bun run dev` convenience script also launches Core (API + worker)
and Vite together. It invokes the web package directly, so it does not generate
the access token supplied by the `bun run dev:web` wrapper. Use the separate
commands above when you need that dev-browser access gate.

### Developing against a remote backend

To iterate on the local web UI against a paired remote instance, first add that
instance to the CLI auth store, then select its label when starting Vite:

```bash
ficus auth login cloud --api-url https://your-instance.ficus.sh
FICUS_DEV_BACKEND=cloud bun run dev:web
```

The dev server keeps the paired device token on the server side and proxies both
HTTP and WebSocket traffic. The browser never receives the token. A persistent
dev bar identifies the selected backend and can switch between CLI backends.
Remote backends are read-only by default: mutating requests are rejected by the
local proxy until **Enable production writes** is checked. Write access resets
to off whenever the backend changes or Vite restarts.

`bun run dev:web` also prints a one-time dev access token. The browser prompts
for it before serving the app or proxying any API or WebSocket traffic, then
stores it in an HttpOnly session cookie. Set `FICUS_DEV_ACCESS_TOKEN` to a value of
at least 16 characters when a stable shared token is needed. The Vite server
serves plain HTTP, so only expose it through an encrypted transport. Do not use
`VITE_FICUS_API_URL` for this workflow; a direct browser connection cannot safely
reuse the production instance's cookie/passkey session.

To serve the UI from the core itself instead, run `bun run build:web` and start
the core with `FICUS_SERVE_WEB=1`; the app, `/api/*` and `/ws` are then all on
`PORT` (this is what setup configures).

### The farm UI

`apps/farm` is a game-style alternative UI (squads as fenced yards, work
streams as plants, agents as robots) built on the same client packages. The web
app's build also builds the farm into `apps/web/dist/farm/`, so every
install, Core artifact and image that ships the web UI ships the farm, and
Core serves it at `/farm` (`FICUS_FARM_DIST` overrides where Core looks).
How it works (styles, settings, presence, farm chat, motion) is in
[`farm.md`](farm.md).

`bun run dev:farm` serves it at `http://127.0.0.1:5174/farm/`, proxying
`/api` and `/ws` to local Core on `:3000` with your browser session (sign in on
the web app first). Add `?demo` for a sample farm that needs no Core. To read
a real instance instead, point it at a backend the CLI is signed in to (the
store is found the way the CLI finds it, or set `FICUS_DEV_AUTH_STORE_PATH`):

```bash
FICUS_FARM_BACKEND=local bun run dev:farm
```

That backend is read-only: the dev server refuses every API write (except the
WebSocket ticket) unless `FICUS_FARM_ALLOW_WRITES=1`. `FICUS_API_URL`
overrides the stored URL, e.g. to use the instance's loopback port.

The installed services and the foreground dev processes are separate.
`ficus server status` and `ficus server logs -f` describe the registered
installation; the dev processes write to their own terminals. To return to
the installed build, stop both foreground dev commands, rebuild the changed
packages, then run `ficus server start`. Do not run both copies on the same
ports.

## Scripts

| Command                                   | Description                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `bun run setup`                           | Install/refresh this checkout into a running instance                         |
| `bun run start`                           | Legacy PM2 path: start Compose and the configured ecosystem apps              |
| `bun run stop`                            | Legacy PM2 path: stop the ecosystem and run Compose down                      |
| `bun run dev`                             | Start API, worker and Vite in watch/dev mode; no generated dev access token   |
| `bun run build`                           | Build all packages                                                            |
| `bun run build:cli`                       | Compile the CLI binary                                                        |
| `bun run test`                            | Prepare this worktree’s test DB, then run configured package test entrypoints |
| `FICUS_MIGRATE_LIVE=1 bun run db:migrate` | Deliberately migrate the root `.env` database                                 |
| `bun run db:generate`                     | Generate migration files from schema changes                                  |
| `bun run logs`                            | Tail pm2 service logs                                                         |
| `bun run pm2:status`                      | Show pm2 process status                                                       |
| `bun run pm2:restart`                     | Restart the apps in this checkout’s PM2 ecosystem                             |
| `bun run lint`                            | Lint all packages with ESLint                                                 |
| `bun run format`                          | ESLint `--fix` plus Prettier over markdown                                    |
| `bun run typecheck`                       | Type-check all packages                                                       |
| `bun run submodules`                      | Initialize/update git submodules (extensions, etc.)                           |
| `bun run sandbox:build:docker`            | Rebuild the Docker sandbox image (sysbox/socket mode)                         |
| `bun run sandbox:kill <id>`               | Kill a sandbox container so it restarts next run                              |
| `bun run sandbox:build:k8s`               | Build the K8s sandbox image                                                   |
| `bun run k3d:setup`                       | Create local k3d cluster for K8s sandbox dev                                  |
| `bun run k3d:start`                       | Start a stopped k3d cluster                                                   |
| `bun run k3d:stop`                        | Stop the k3d cluster (preserves state)                                        |
| `bun run k3d:status`                      | Show cluster status, pods, PVC                                                |
| `bun run k3d:pods`                        | List sandbox pods                                                             |
| `bun run k3d:logs`                        | Tail logs from a sandbox pod                                                  |
| `bun run k3d:shell`                       | Shell into a sandbox pod                                                      |
| `bun run k3d:kill`                        | Kill sandbox pods (recreated on next use)                                     |
| `bun run k3d:import`                      | Rebuild sandbox image and import into k3d                                     |
| `bun run k3d:teardown`                    | Delete the k3d cluster entirely                                               |
| `bun run docker:gc`                       | Reclaim dev docker disk (orphaned test DBs, registry)                         |
| `bun run docker:gc -- --install`          | Install the daily 13:00 launchd job for the above                             |
| `bun run core:build`                      | Build the Core Docker image (API + worker + web)                              |
| `bun run ecr:login`                       | Log in to AWS ECR (required before push)                                      |
| `bun run ecr:push`                        | Build and push both images to ECR                                             |
| `bun run deploy`                          | Full deploy: build, push to ECR, restart K8s                                  |

The PM2 scripts require an installation configured to use PM2 and its ecosystem
file; they do not manage native launchd/systemd-user services. In particular,
`bun run start` does not automatically create a separate Vite web process:
the example's web app entry is commented out, and normal installed setup
serves the built web app through Core.

The pm2 scripts (`start:core`, `stop:core`, `reload:api`, `reload:worker`) do not
hard-code `ficus-api` / `ficus-worker`: they resolve this checkout's app names with
`$(bun scripts/pm2-name.ts api|worker)`, which reads `FICUS_PM2_API_NAME` /
`FICUS_PM2_WORKER_NAME` from the checkout's `.env`, so they address the right
instance when several are installed
([docs/wiki/setup.md → Multiple instances](setup.md#multiple-instances)).

## Testing

Database-backed tests use a separate Docker Compose project and dynamically
allocated PostgreSQL port for each worktree. Core's preload prepares and
checks the schema; root `bun run test` waits for database readiness before
starting the configured package suites. Do not point tests at the development
database or assume the Compose file's fallback port 5433 is the actual test
port.

The preload derives foreign keys from `schema.ts` and synchronizes them in both
fresh and reused test databases. Fixtures must create referenced parents and
remove restrictive children (including durable chat receipts) before their
messages or executions. If an older disposable database contains orphaned
fixtures, reset only this worktree’s database with `bun run test:db:down`; do not
remove constraints to make a test pass.

```bash
# Configured package test entrypoints, with DB readiness first
bun run test

# A package suite, with its isolation/completion contract
bun run --filter core test

# Web's full test gate is a separate package command
bun run --filter web test:ci

# Focused diagnosis only; not a replacement for the package suite
bun test apps/core/src/services/maintenance/store.test.ts
```

The full web gate includes `src/no-server-only-imports.test.ts`. It rejects
server-only OAuth provider and broker subpaths in browser source, excluding
conventionally named test files so fixture references are not mistaken for
shipped code. Import the public GitHub App client ID from
`@ficus/shared/github-app`, a dependency-free module containing no credentials;
the old provider subpath remains a compatibility re-export for server callers.

Use the package test runner for acceptance. Core isolates files that replace
modules, while other packages have their own subprocess and completion
requirements. A zero process exit without a complete zero-failure summary is
not sufficient evidence. Report actual completed tests and any skips; see
[AGENTS.md](../../AGENTS.md#testing) for fixture ownership and test discipline.

See the package test entrypoints for suite-specific guidance and [`ci-cd.md`](ci-cd.md)
for what gates a merge.

## PostgreSQL (Docker)

```bash
# Default Compose development database (persistent volume)
bun run docker:up

# This worktree's isolated test database (allocated port, disposable data)
bun run test:db:up

# Reset only this worktree's disposable test database
bun run test:db:down
```

The development database may instead be the installer-managed container or
an external server named by this checkout's `DATABASE_URL`; do not start a
second default Compose database over that installation. `test:db:up` prints
its allocated port and project. Prefer these isolation-aware test commands
over the raw `docker:up:test`/`docker:down:test` Compose shortcuts.

Schema and migration workflow live in [`database.md`](database.md).

## Local K8s development (k3d)

For development, you can run sandboxes in a local Kubernetes cluster using
[k3d](https://k3d.io/) (k3s-in-Docker). This exercises the Kubernetes sandbox
runtime locally, but local port forwarding, host mounts, runtime classes and
resource settings differ from a production cluster. Local success does not
replace validation on the deployment topology you are changing.
`bun run setup -- --runtime k3d` does the setup below for you.

### Setup

```bash
# One-time: create cluster, build image, configure namespace/PVC
bun run k3d:setup

# Add to your .env:
FICUS_SANDBOX_RUNTIME=k8s
FICUS_K8S_LOCAL=true
FICUS_K8S_NAMESPACE=tau-sandboxes-dev
FICUS_K8S_RUNTIME_CLASS=
# Optional: override sandbox pod memory limit (local default is 8Gi)
# FICUS_SANDBOX_MEMORY_LIMIT=8Gi

# Installed build: restart using its recorded supervisor
ficus server restart
# For source development, use the dev loop above instead
```

### Day-to-day

```bash
bun run k3d:start       # Resume a stopped cluster
bun run k3d:stop        # Pause (saves battery/RAM, state preserved)
bun run k3d:status      # Cluster health, pods, PVC status
bun run k3d:pods        # List sandbox pods
bun run k3d:logs        # Tail logs from latest sandbox pod
bun run k3d:shell       # Shell into latest sandbox pod
bun run k3d:kill        # Kill pods (recreated on next use)
```

### After changing sandbox code

```bash
bun run k3d:import      # Rebuild image and import into cluster
bun run k3d:kill        # Kill running pods so they pick up the new image
```

### How it works

- **k3d** runs a single-node k3s cluster inside a Docker container
- **`~/.tau/`** is mounted into the k3d node via hostPath, so the host API and sandbox pods share workspace/memory/SSH data through a static PV/PVC
- **`kubectl port-forward`** bridges host → pod networking (managed automatically by `K8sPodManager`)
- Sandbox pods use **`host.k3d.internal`** to reach the API running on the host
- The local build script derives its Linux image architecture from the host (`amd64` or `arm64`); it does not always force x64 emulation on Apple Silicon.

### Disk hygiene

Day-to-day dev accumulates docker disk until the OrbStack VM self-stops on a
full host disk (killing every sandbox). Two growth mechanisms dominate: the
local registry never garbage-collects the image blobs orphaned by each
`k3d:import` re-push of `:latest`, and test-DB compose projects orphaned by
deleted worktrees keep running forever (see `scripts/docker-gc.ts` for the
full list).

```bash
bun run docker:gc               # One-shot: orphaned test DBs, registry GC,
                                # dangling images/build cache, k3d node prune
bun run docker:gc -- --install  # Install/refresh a daily 13:00 launchd agent
                                # (dev.ficus.docker-gc, logs to /tmp/ficus-docker-gc.log)
```

Normal test runs do not sweep other worktrees' database projects. Orphan
cleanup is explicit through `bun run docker:gc`; the test preload also supports
the opt-in `FICUS_TEST_SWEEP_ORPHANS=1` maintenance path, throttled to at most once
an hour. A project is eligible only after its owning worktree no longer exists.

For installations that explicitly use PM2, its logs can grow without a
rotation policy. The optional PM2 logrotate module controls those logs only;
it does not configure native supervisor logs:

```bash
bunx pm2 install pm2-logrotate
bunx pm2 set pm2-logrotate:max_size 100M   # rotate when a log hits 100 MB
bunx pm2 set pm2-logrotate:retain 3        # keep 3 rotated files per log
bunx pm2 set pm2-logrotate:compress true   # gzip rotated files
bunx pm2 save                              # persist across pm2 resurrections
```

### Teardown

```bash
bun run k3d:teardown    # Delete cluster entirely (data in ~/.tau/ preserved)
```
