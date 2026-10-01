# Ficus Setup Guide

How to get a running Ficus. Pick your path:

| Path                    | Best for                                                                              | Where                                          |
| ----------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Local install**       | Your laptop or a dev box — nothing → running ficus in one command, no root            | [Local setup](#local-setup) below              |
| **Production Linux VM** | A fresh Ubuntu 24.04 host you own (root + systemd), or a cloud VM provisioned for you | [Setup toolkit](../../scripts/setup/README.md) |
| **Kubernetes**          | Multi-tenant cluster deployments                                                      | [K8s Deployment Guide](k8s/deployment.md)      |
| **Hosted**              | Let us run it                                                                         | [ficus.sh](https://ficus.sh)                   |

Every path needs a sandbox runtime (`FICUS_SANDBOX_RUNTIME`, required, no
default) — [docs/wiki/sandbox-runtimes.md](sandbox-runtimes.md) compares them.

Developing ficus itself (git identity, commit signing, `bun run dev`) is a
different job from installing it; that material lives in
[docs/wiki/development.md](development.md).

## Local setup

`bun run setup` takes a checkout from nothing → a running ficus: `.env` written,
PostgreSQL up, database migrated, core/CLI/web built, the sandbox runtime
prepared, and api + worker running under the selected local supervisor with a URL to open. It is
idempotent — re-running it never regenerates secrets, and it keeps values you
set yourself unless you pass the matching flag (see
["Replaced when"](#what-it-writes) below).

### One command

```bash
curl -fsSL https://ficus.sh/cli/setup.sh | bash
```

Fully headless (no prompt at all):

```bash
curl -fsSL https://ficus.sh/cli/setup.sh | bash -s -- --runtime host --yes
```

Everything after `bash -s --` goes to `ficus server install`. It consumes
`--root` (where to clone), `--repo` and `--ref` — which must come first — and
forwards everything else verbatim to setup, so any other flag from the
[table below](#flags) works there.

What the one-liner does, in order:

1. Installs the `ficus` CLI into `~/.ficus/bin` — `FICUS_INSTALL_DIR` overrides that
   directory (both the one-liner and the CLI installer honour it). The install
   is skipped when `~/.ficus/bin/ficus` already exists **and**
   `FICUS_SETUP_SKIP_CLI_INSTALL=1`; the installer URL comes from
   `FICUS_INSTALL_URL`, default `https://ficus.sh/cli/install.sh`.
2. Runs `ficus server install`, which installs bun with the official installer if
   it is missing, then clones `https://github.com/ficushq/tau.git` into
   `~/.ficus/ficus` (`--root <dir>` to clone elsewhere). Without `--root`, the
   registered default instance's checkout is reused wherever it lives. An
   existing checkout at the target is reused untouched, and a non-empty
   directory that is not a checkout is an error.
3. `bun install --frozen-lockfile` in the checkout.
4. Hands off to the checkout's own `bun run setup` with your flags. The
   compiled CLI never runs installer logic of its own — setup always comes from
   the source it just installed.

`curl` and `git` must already be present. Bun's installer also needs `unzip`,
which stock Ubuntu/Debian images ship without: on an apt host where you are
root or `sudo` works without a prompt, the installer adds it itself; anywhere
else, `sudo apt install unzip` first. Under `curl … | bash` the installer
reattaches stdin from `/dev/tty` so the runtime prompt still works; with no
terminal at all it exits with the "no terminal and no runtime chosen" error.

`ficus server install` can also be run directly, e.g.
`ficus server install --root /srv/ficus --ref main -- --runtime docker-socket --yes`
(`--root`, `--repo` and `--ref` must come **before** the pass-through setup
flags).

### From a checkout

```bash
git clone --recurse-submodules https://github.com/ficushq/tau.git
cd tau
bun install
bun run setup
```

`bun run setup` is `ficus server setup` run from the source
(`bun apps/cli/src/index.ts server setup`). Pass flags after `--`:

```bash
bun run setup -- --runtime host --port 3000
```

### What setup asks

Up to two things. First the runtime, and only when neither `--runtime` nor
`FICUS_SETUP_RUNTIME` is set:

```
Where should agents run?
  host           — no sandbox: agents run on this machine as you (fastest; zero isolation)
  docker-socket  — containers via the host Docker socket (any Docker host, incl. macOS)
  docker-sysbox  — containers with real Docker-in-Docker via sysbox (Linux + sysbox installed)
  k3d            — sandbox pods in a local k3d cluster (heaviest; matches the k8s runtime)
```

[docs/wiki/sandbox-runtimes.md](sandbox-runtimes.md) is the chooser if none of
those is an obvious yes. `--runtime k8s` and `--runtime vm` are not installed by
this installer: they need a cluster or a machine fleet, so setup exits with a
pointer to that doc.

Then, on a terminal, setup prints the plan it is about to execute (the same one
`--dry-run` prints) and asks for one confirmation:

```
Proceed with setup? [Y/n]
```

Answering anything but yes cancels before a single step runs. `--yes` skips this
confirmation, and a headless run (no terminal) never shows it. Note that `--yes`
does **not** answer the runtime question: a headless run must pass `--runtime`
(or `FICUS_SETUP_RUNTIME`), otherwise setup exits 2 listing the flags.

### Flags

Every flag that takes a value is mirrored by an environment variable for
headless use; the flag wins when both are set.

| Flag                                                  | Env mirror                 | Default                                                          | Notes                                                                                                                                |
| ----------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--runtime <host\|docker-socket\|docker-sysbox\|k3d>` | `FICUS_SETUP_RUNTIME`      | asked                                                            | `k8s` / `vm` exit with a pointer to the runtime doc                                                                                  |
| `--supervisor <pm2\|launchd\|systemd-user>`           | `FICUS_SETUP_SUPERVISOR`   | macOS: `launchd`; Linux: `systemd-user`                          | `pm2` remains selectable; native supervisors are OS-specific                                                                         |
| `--instance <label>`                                  | `FICUS_SETUP_INSTANCE`     | the checkout's label, else `ficus`                               | names every per-instance resource — see [Multiple instances](#multiple-instances)                                                    |
| `--home-dir <path>`                                   | `FICUS_SETUP_HOME_DIR`     | `~/.ficus`, or `~/.ficus-<label>`                                | written to `.env` when given, or when the instance is labelled; a leading `~` is expanded by the core                                |
| `--port <n>`                                          | `FICUS_SETUP_PORT`         | `3000` on a fresh checkout; a re-run keeps the checkout's `PORT` | sets `PORT`, derives `WORKER_PORT` (+2), `FICUS_WORKER_EVENT_PORT` (+3), `FICUS_API_URL`, `APP_URL`, `FICUS_WEB_ORIGIN`; max `65532` |
| `--app-url <origin>`                                  | `FICUS_SETUP_APP_URL`      | `http://localhost:<port>`                                        | must be a bare origin (`scheme://host[:port]`, no path) — a path breaks passkeys                                                     |
| `--database-url <dsn>`                                | `FICUS_SETUP_DATABASE_URL` | the managed container                                            | use an existing PostgreSQL; no container is then created or started                                                                  |
| `--db-name <name>`                                    | `FICUS_SETUP_DB_NAME`      | `ficus`                                                          | managed container only, created if missing; mutually exclusive with `--database-url`                                                 |
| `--db-port <n>`                                       | `FICUS_SETUP_DB_PORT`      | `5432` for `tau`, else the first free port from 5433             | host port the managed PostgreSQL container publishes on loopback                                                                     |
| `--default`                                           | —                          | off                                                              | make this instance the fallback for bare `ficus server …` commands run outside any checkout (inside a checkout, that checkout wins)  |
| `--no-start`                                          | —                          | starts                                                           | write configuration/registry only; do not register or start a supervisor                                                             |
| `--dry-run`                                           | —                          | off                                                              | print the plan (secrets redacted), change nothing, exit 0                                                                            |
| `--yes`                                               | —                          | off                                                              | skip the plan confirmation (the runtime question is still asked on a TTY)                                                            |
| `--rebuild-image`                                     | —                          | off                                                              | rebuild `ficus-sandbox:latest` even if it already exists                                                                             |
| `--root <dir>`                                        | `FICUS_SERVER_ROOT`        | resolved (see below)                                             | the checkout to operate on                                                                                                           |

The checkout a `ficus server` management command (`start`, `stop`, `restart`,
`status`, `logs`, `update`, `uninstall`) acts on is resolved in this order:
`--root` > `FICUS_SERVER_ROOT` > `--instance <label>` (or `FICUS_INSTANCE` in the
environment) looked up in the registry > the checkout you are standing in >
the registry's default instance. A label you pass explicitly is honoured or
refused; one that merely happens to be in the environment is ignored when the
registry cannot use it. **Setup root resolution never selects a checkout from the registry**: `--root` >
`FICUS_SERVER_ROOT` > the checkout you are in — otherwise running setup in a
second checkout would reconfigure the installed one.

### What it writes

Three things, in the checkout and in your home directory:

- **`.env`** — copied from `.env.example` if missing, then merged key by key and
  `chmod 600`. Comments, ordering and every key setup does not manage are
  preserved; managed keys that are missing are appended under a single
  `# --- added by ficus setup ---` comment.
- **Supervisor definition** — PM2 installs generate `ecosystem.config.js`. Native installs create paired definitions when started: `~/Library/LaunchAgents/sh.ficus.<process>.plist` on macOS or `${XDG_CONFIG_HOME:-~/.config}/systemd/user/<process>.service` on Linux. Native setup leaves any existing ecosystem file untouched.
- **`~/.ficus/cli/local-server.json`** — the instance registry:
  `{ "version": 3, "default": "<label>", "instances": { "<label>": { root, port, supervisor, createdAt, updatedAt, identity: 2 } } }`,
  so `ficus server …` finds every install from anywhere. Version-1 and version-2 records migrate in memory to `supervisor: "pm2"`; malformed version-3 or future-version state fails closed. Setup adds its
  instance and takes the default when it is the first one or `--default` is
  passed. `identity: 2` marks an instance that runs under the Ficus names; an
  entry without it was installed before the rename and keeps its old names until
  [`ficus server rename-identity`](#moving-an-install-made-before-the-rename) moves it.

The managed `.env` keys:

| Key                                                                 | Value                                                                                                                                                                                | Replaced when                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `FICUS_SANDBOX_RUNTIME`                                             | the chosen runtime (`k3d` is written as `k8s`)                                                                                                                                       | `--runtime`                                |
| `FICUS_K8S_LOCAL`, `FICUS_K8S_NAMESPACE`, `FICUS_K8S_RUNTIME_CLASS` | `true`, `ficus-sandboxes-dev`, empty — k3d only; otherwise a `FICUS_K8S_LOCAL=true` already in .env is blanked (it applies only to the k8s runtime) and the other two are left alone | `--runtime`                                |
| `FICUS_ENCRYPTION_KEY`                                              | random 32-byte hex, only when empty                                                                                                                                                  | never                                      |
| `FICUS_INTERNAL_EVENT_TOKEN`                                        | random 32-byte hex, only when empty                                                                                                                                                  | never                                      |
| `FICUS_PASSWORD`                                                    | random 24-byte token, only when empty                                                                                                                                                | never                                      |
| `FICUS_SERVE_WEB`                                                   | `1` (the core serves the built web UI on `PORT`)                                                                                                                                     | never                                      |
| `FICUS_INSTANCE`                                                    | the instance label (`ficus` unless `--instance` says otherwise); a re-run with a _different_ `--instance` is refused, not replaced                                                   | `--instance`                               |
| `PORT`                                                              | the port                                                                                                                                                                             | `--port`                                   |
| `WORKER_PORT`                                                       | `PORT + 2`                                                                                                                                                                           | `--port`                                   |
| `FICUS_WORKER_EVENT_PORT`                                           | `PORT + 3`                                                                                                                                                                           | `--port`                                   |
| `FICUS_API_URL`                                                     | `http://localhost:<port>`                                                                                                                                                            | `--port`                                   |
| `APP_URL`, `FICUS_WEB_ORIGIN`                                       | the app URL                                                                                                                                                                          | `--app-url`, `--port`                      |
| `DATABASE_URL`                                                      | your DSN, or the managed container's URL with the database name                                                                                                                      | `--database-url`, `--db-name`, `--db-port` |
| `HOME_DIR`                                                          | `--home-dir` when given; otherwise `~/.ficus-<label>`, and nothing at all for the `ficus` instance (the core's own default `~/.ficus`)                                               | `--home-dir`, `--instance`                 |
| `FICUS_UPDATE_SUPERVISOR`                                           | selected supervisor                                                                                                                                                                  | always reconciled                          |
| `FICUS_SYSTEM_LOG_PROVIDER`                                         | `pm2` for PM2; `file` for native supervisors                                                                                                                                         | always reconciled                          |
| `FICUS_PM2_API_NAME`, `FICUS_PM2_WORKER_NAME`                       | derived app names for PM2; cleared for native supervisors                                                                                                                            | always reconciled                          |
| `FICUS_LOG_FILE_API`, `FICUS_LOG_FILE_WORKER`                       | absolute `~/.ficus/logs/<process>.log` paths for native supervisors; cleared for PM2                                                                                                 | always reconciled                          |

"Replaced when" is the whole rule: an existing non-empty value is kept unless
you passed the flag (or env mirror) that owns it. One exception is baked in —
`.env.example`'s placeholder `APP_URL=https://your-domain.com` counts as empty,
so setup always replaces it. Secrets are generated once and
never regenerated — re-running setup on a working install cannot lock you out.

The steps, in order: preflight → config files → `.env` → PostgreSQL → migrate
(`FICUS_MIGRATE_LIVE=1`) → build core, CLI and web → sandbox image or k3d cluster
→ start worker first and API last under the selected supervisor and wait for the API → handoff. The registry entry is written
**before** the start step — so `ficus server logs` can reach the instance even if
the health wait fails — and refreshed after it. Each step
checks before acting: an existing `ficus-sandbox:latest` image or `ficus-dev` k3d
cluster is left alone (`--rebuild-image` forces the image), builds are
incremental, and starting an already-running pair is a restart.

The PostgreSQL step never calls `docker compose`. It runs the container itself —
`docker run -d --name postgres-ficus --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5432:5432 -v ficus_postgres-data:/var/lib/postgresql paradedb/paradedb:latest`
(the name, volume and port come from the instance; a first run pulls the image,
which takes minutes) — or, when a container of that name already exists,
**starts** it and adopts the port it publishes. A container `docker compose`
created for this checkout is exactly such a container, so an existing dev
install is reused rather than duplicated. Setup then waits until the database
answers three times in a row (ParadeDB restarts once during first init) and
creates the database if it is missing. A `DATABASE_URL` on loopback whose
credentials are not the container's is a PostgreSQL **you** run: setup treats it
as external, never picks its port for you and never builds a container over it
(it is still waited for, like any external database, so it must be running).

`--dry-run` prints exactly that plan, including the `.env` diff with secret
values shown as `<redacted>`, and touches nothing — no files, no Docker, and no supervisor commands:

```bash
bun run setup -- --runtime host --dry-run
```

The health check that ends a real run probes `/health`, the core's public
liveness route, and accepts **200 or 401**: 200 is the normal answer, and 401 is
accepted because a reverse proxy in front of the instance may gate the route —
either way something is answering, which is what the probe proves. (`/api/*`
sits behind identity middleware and answers 401 to an unauthenticated probe;
that also means the API is up, but `/health` is the direct check.)

### Managing it

None of these need the API, an account, or a network:

```bash
ficus server list              # every instance on this machine: label, supervisor, root, URL, default, process states
ficus server status            # instance, supervisor, root, port, runtime, commit, process states, health (--json for machines)
ficus server logs -f           # recorded-supervisor logs; -c api|worker to narrow, -n N for history
ficus server restart           # also: start, stop
ficus server use smoke         # make `smoke` the instance bare commands act on
ficus server uninstall         # remove supervisor registration + registry entry; deletes no data
ficus server bootstrap-sysbox  # (Linux host) install the sysbox runtime docker-sysbox needs; --dry-run to preview
```

Each one acts on a single instance — add `--instance <label>` to the subcommand
(`ficus server logs --instance smoke -f`) to pick another one; see
[Multiple instances](#multiple-instances). (`ficus server list` needs no label: it
prints every instance.)

`ficus server use <label>` changes which instance the bare commands act on, the
way `ficus auth use` switches backends. It only moves the registry's `default`,
so it matters when you are outside any checkout — inside a checkout, that
checkout still wins — and `--instance` overrides both. It is also the repair
for a registry whose `default` was lost or points at a label that no longer
exists.

`ficus server uninstall` asks for confirmation first — pass `--yes` to skip the
prompt, which is required when there is no terminal (it refuses to run
unattended otherwise). It prints what it deliberately left behind (the
checkout, the instance's PostgreSQL container and volume, and `HOME_DIR`) with
the commands to remove them by hand, and says which registry entry it dropped.
If the checkout itself is already gone (a deleted worktree, a scratch
directory), `ficus server uninstall --instance <label>` still retires the
registration: it cleans the supervisor up as far as it can, drops the registry
entry, and lists the container, volume and data directory it left behind.

To update:

```bash
ficus server update            # this checkout: git pull + rebuild, then restart the recorded supervisor (works with the API down)
ficus update apply             # the instance the CLI is pointed at, through its API
ficus update status --offline  # read the checkout's local update status file
```

The two commands target different things. `ficus server update` always acts on
the checkout on this machine (`--root`, `FICUS_SERVER_ROOT`, the local-server
record, or the checkout you are in) and never needs the API — use it for a
local install. `ficus update apply` posts to `/api/updates/apply` on whatever
backend the CLI is pointed at (`--backend`, the active `ficus auth login`
backend, `FICUS_API_URL`), which may be a cloud instance; it announces the
target first. It falls back to the offline path only when that target is
unreachable at the transport level **and** is the local instance itself (a
loopback address on this checkout's port) — an unreachable remote backend, an
auth failure or an HTTP error is reported, never turned into a git pull on
this machine. The offline path refuses a dirty tree and fast-forwards the current branch
without fetching tags. With the offline-only `--ref <branch|tag|commit>`, it
fetches only that exact ref before checking it out. Release tags remain
immutable: an existing local release tag that disagrees with origin is an
error. `nightly` is the intentional moving-channel tag, so only an explicitly
requested `--ref nightly` may force-refresh that one local tag; unrelated tags
are never rewritten. The updater then runs the checkout's
`bun run update:offline -- --from <old-sha>` — the same task table as the
in-app updater, minus the restarts — and then restarts through the supervisor
recorded in the registry, worker first and API last. It prints the old → new commit.

Native persistence behavior:

- launchd definitions start at GUI login and stop at logout; they do not prove or provide logged-out execution.
- systemd user units start with the user manager. Setup checks linger, attempts `loginctl enable-linger <user>` without sudo, and warns with the exact `sudo loginctl enable-linger <user>` command when policy prevents it.
- PM2 remains explicit. Setup runs `pm2 save`; for optional reboot startup, run `cd <checkout> && bunx pm2 startup` and then the privileged command PM2 prints.

To change supervisors safely, first run `ficus server uninstall --root <checkout>`, then rerun `bun run setup -- --supervisor <new>`. Setup refuses an in-place supervisor change so two managers cannot bind the same ports.

### Multiple instances

Several ficus installs can run on one machine at once. Each one is an **instance**
with a label, and the label names every resource the instance owns, so nothing
is shared by accident. The label of an existing install is `tau`, and the `tau`
label keeps today's names exactly — installing a second instance changes nothing
about the first.

An instance is a checkout: `.env` and `ecosystem.config.js` belong to one label,
so give the second instance its own clone.

```bash
git clone --recurse-submodules https://github.com/ficushq/tau.git ficus-smoke
cd ficus-smoke && bun install
bun run setup -- --instance smoke --runtime host --port 3100
```

That is the whole command: the port, database, data root, and supervisor
process/service names all follow from `--instance smoke` and `--port 3100`.

**What the label names**

| Resource               | `ficus` (the default)             | `--instance <label>`                        |
| ---------------------- | --------------------------------- | ------------------------------------------- |
| process/service names  | `ficus-api`, `ficus-worker`       | `ficus-<label>-api`, `ficus-<label>-worker` |
| launchd labels         | `sh.ficus.ficus-api`, …           | `sh.ficus.ficus-<label>-api`, …             |
| PostgreSQL container   | `postgres-ficus`                  | `postgres-ficus-<label>`                    |
| PostgreSQL data volume | `ficus_postgres-data`             | `ficus-<label>_postgres-data`               |
| `HOME_DIR`             | `~/.ficus` (left unset in `.env`) | `~/.ficus-<label>`                          |

A label is lowercased first, and must then be letters, digits and inner dashes —
1 to 31 characters, starting and ending with a letter or digit. Anything else is
rejected before setup touches the checkout.

**Ports**

| Value                     | Comes from                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `PORT`                    | `--port` — default `3000` on a fresh checkout; a re-run keeps the checkout's `PORT` (max `65532`) |
| `WORKER_PORT`             | `PORT + 2`                                                                                        |
| `FICUS_WORKER_EVENT_PORT` | `PORT + 3`                                                                                        |
| PostgreSQL host port      | `--db-port`; by default `5432` for `ficus`, else the first free port from 5433                    |

The default instance therefore keeps 3000/3002/3003 and 5432. For the database
port setup follows, in order: an explicit `--db-port`; the port this instance's
own container already publishes (running or stopped — a container's mapping is
fixed when it is created, so setup obeys it rather than picking); the port a
`DATABASE_URL` it previously wrote names, provided nothing foreign listens
there; then the default above. Every resolved value is written to `.env` once
and reused from then on.

**Managing them**

```bash
ficus server list                          # label, root, URL, default marker, supervisor states
ficus server status --instance smoke       # --instance belongs to the subcommand
ficus server logs --instance smoke -f
ficus server uninstall --instance smoke
```

`ficus server list` reads `~/.ficus/cli/local-server.json`, the registry setup
writes an entry into (`{ root, port, supervisor, createdAt, updatedAt, identity }` per label). Which
instance a command acts on is decided in this order: `--root` >
`FICUS_SERVER_ROOT` > `--instance` (or `FICUS_INSTANCE`) > the checkout you are
standing in > the registry's default instance — the first one installed, or
whichever passed `--default` (also in [Flags](#flags)). `ficus server uninstall`
drops the entry and hands the default to a remaining instance; it deletes no
data.

**Re-running setup**

A re-run in a checkout that is already an instance keeps what that checkout is:
its label and its port come from its own `.env` unless `--instance` / `--port`
(or the `FICUS_SETUP_*` mirrors) say otherwise. Passing a **different**
`--instance` is refused —

```
this checkout is instance "ficus"; to relabel it, remove FICUS_INSTANCE from .env (after unregistering its supervisor with ficus server uninstall --root /path/to/checkout) — or set up a fresh checkout
```

— because relabelling would orphan the supervisor registrations, container,
database and data directory the old label owns. The message is the whole recipe:
`ficus server uninstall` unregisters the supervisor but does **not**
clear the label, so removing `FICUS_INSTANCE` from `.env` is the part that
actually relabels the checkout. A checkout with **no** label yet — an
install made before labels existed, or a hand-copied `.env` — may take one: setup
regenerates `ecosystem.config.js` for the new pm2 names, warning that hand edits
were discarded, and warns that `HOME_DIR` now points at `~/.ficus-<label>` while
saying whether `DATABASE_URL` moved with it.

**Two checkouts, one label**

Nothing stops two checkouts from claiming the same label, so setup checks before
starting: if pm2 already runs this instance's apps **online** from a different
checkout, it stops with

```
pm2 already runs ficus-api for instance "ficus" from another checkout (/path/to/other). Give this checkout its own label with --instance <other-label>, or ficus server uninstall --root /path/to/other the other one
```

Both ways out are in the message: a label of its own for this checkout, or
unregistering the checkout that holds the label. Stopped pm2 entries are
ignored, so this only blocks while the other checkout is actually running.

**The k3d runtime is single-instance.** `bun run k3d:setup` creates one cluster
(`ficus-dev`) and bind-mounts `~/.ficus` into it, neither of which is per-instance —
so run k3d on the default `ficus` instance only, and give the extra instances
`host` or a docker runtime.

[docs/wiki/sandbox-runtimes.md](sandbox-runtimes.md#second-instance-beside-an-existing-one)
lists the same separation for a second instance you wire up by hand instead of
with `--instance`.

### Moving an install made before the rename

An instance installed before Ficus took its name keeps its old names — launchd
labels, process and unit names, its PostgreSQL container, volume and database,
the old CLI home, and for the default instance the old label — and every
`ficus server` command keeps addressing it by them.
Its registry entry has no `identity: 2`. Setup refuses to re-run on it, since it
would bring the instance up a second time under the new names.

`ficus server rename-identity` moves one such instance to the Ficus names:

```bash
ficus server rename-identity --root <checkout> --dry-run   # print the plan, change nothing
ficus server rename-identity --root <checkout>
ficus server rename-identity --root <checkout> --undo      # back to the old names, after a completed run
```

In order, printing each step:

1. reads the instance's registry entry;
2. stops both processes under the old names so that nothing restarts them, not
   even a reboot (launchd `bootout` and `disable`, systemd `disable --now`, pm2
   `delete` and `save --force`);
3. when the instance uses the default data home, moves the CLI home to
   `~/.ficus` (leaving the old path as a link to it) and rewrites the home paths
   stored in the database (`apps/core/dist/rebase-home.js`);
4. copies `.env` to `.env.pre-ficus-rename-<UTC time>` and, when the home moved,
   writes `HOME_DIR=~/.ficus` into it;
5. moves an installer-managed PostgreSQL to `postgres-ficus`,
   `ficus_postgres-data` and the database `ficus` (an external database is left
   alone);
6. rewrites `FICUS_INSTANCE`, `FICUS_PM2_*_NAME` and `FICUS_LOG_FILE_*` where
   they name the old identity;
7. renames the apps in `ecosystem.config.js` in place (pm2) — every other line,
   such as `max_memory_restart` or a pinned port, is kept, and the old file is
   kept beside the journal;
8. relabels the default instance to `ficus` in the registry and marks the entry
   `identity: 2` (the registry stays at version 3);
9. installs and starts the new launchd jobs, systemd units or pm2 apps, and
   removes the old plists or units. pm2 gets the environment from `.env` as the
   run rewrote it, never the one the CLI loaded when it started;
10. waits up to 120 s for `/ready` to answer 200 (the database is reachable and
    migrated), then gives the new PostgreSQL container the old one's restart
    policy.

`--dry-run` also prints the `ecosystem.config.js` change as a diff, and asks the
rebase program how many rows it would change (and warns when the database
already holds paths under `~/.ficus`, which would make step 3 refuse).

The command refuses, changing nothing, when the old CLI home is a symlink to a
directory elsewhere: move that directory to `~/.ficus` by hand and leave the old
path as a link to `.ficus` first.

Every step is written to `<CLI home>/rename-identity.journal` before it acts,
and only one run holds it at a time. If a step fails, both identities are
stopped, the completed steps are undone in reverse, and the instance is
restarted under its old names and checked with `/ready` — or, if it was not
running when the command started, left stopped with its definitions restored. A run cut short (a crash, a closed terminal) is
resolved by the next `rename-identity` for that checkout before anything else —
finished if its readiness check had passed, undone otherwise — and
`ficus server start`, `restart` and `update` refuse to run until then. A
completed run keeps its journal as `rename-identity.<label>.journal` for
`--undo`. Once the new processes may have written to the new PostgreSQL volume,
an undo keeps that volume and says so: the restored database is the snapshot
from before the rename.

A checkout managed by `docker compose` directly (`bun run start` / `reload` /
`docker:up`, rather than `ficus server setup`) has no CLI identity for
`rename-identity` to act on, but it names its Postgres container and volume
the same way `ficus server setup` does for the default instance
(`postgres-ficus`, `ficus_postgres-data`) — so the two never run as separate
copies of the same instance: whichever side creates that container first owns
the name, and the other either adopts the existing one (the CLI installer) or
fails outright with a "name already in use" conflict (`docker compose up`)
rather than silently starting a second Postgres on the same data.

That container-name pin existed before this release; the **volume** name
becoming an explicit, fixed `ficus_postgres-data` is new. An install that was
already running under `docker compose` keeps its data in whatever volume it
was using before (Compose derives a name from the checkout directory when
none is pinned) — a _different_ name from the new fixed one. A plain
`docker compose up` after upgrading will not find that old volume, so it
creates `ficus_postgres-data` fresh and empty and the container boots an
empty database, leaving the real data in the old volume, untouched and
unreferenced. Converge the two by hand, once, with the app stopped:

1. Find the old volume: `docker volume ls`, or if the old container is still
   around, `docker inspect <old container> --format '{{json .Mounts}}'`.
2. Stop the stack (`bun run stop`, or `docker compose down`).
3. Copy its data into the new volume (creates `ficus_postgres-data` if it
   does not already exist):
   ```bash
   docker run --rm -v <old volume>:/from:ro -v ficus_postgres-data:/to \
     paradedb/paradedb:latest sh -c 'cp -a /from/. /to/'
   ```
4. Start Postgres only and rename the database inside the copy (the running
   container is now `postgres-ficus`, on the copied data):
   ```bash
   docker compose up -d postgres
   docker compose exec postgres psql -U postgres -c 'ALTER DATABASE "<old database name>" RENAME TO ficus'
   ```
5. Update `DATABASE_URL` in `.env` to name `ficus`, then start the rest
   normally (`bun run start`). Nothing here deletes the old volume or
   container — remove them yourself once you've confirmed the copy.

A fresh `docker compose up` with no pre-existing install needs none of this:
the container's first boot creates `ficus_postgres-data` and the `ficus`
database directly, and (per [What it writes](#what-it-writes) above) `ficus
server setup` adopts that same container and volume for the default instance
either way, so a dev checkout and a `ficus server`-managed one never fork the
same data from a clean start.

### Notes

- The default checkout `~/.ficus/ficus` lives inside `~/.ficus`, which is also
  Ficus's default data root (`HOME_DIR`). Source and data sit side by side;
  Ficus's storage never writes into `~/.ficus/ficus`.
- The k3d runtime bind-mounts `~/.ficus` into the cluster so pods and the host see
  the same workspace files. That mount includes the checkout at `~/.ficus/ficus` —
  harmless, but worth knowing before you point `--home-dir` somewhere exotic.

## After setup

### First admin

Open the URL setup printed. It looks like
`http://localhost:3000/#setup=<password>`: the fragment carries the instance
password, and the login page signs you in with it and strips it from the
address bar. A fragment is never sent to the server, so it does not reach
access logs.

1. If you open the plain URL instead, the login page asks for the instance
   password. Setup generated a random `FICUS_PASSWORD` and wrote it to `.env`;
   read it with:

   ```bash
   grep '^FICUS_PASSWORD=' ~/.ficus/ficus/.env   # or .env in your own checkout
   ```

2. Create your account. The **first passkey becomes the system admin**.
3. The email is optional for this first admin (managed cloud instances
   excepted). Without one, the account has no email address and signs in with
   its passkey only. An email you do enter is verified with a code only when the
   instance has an email provider to mail it.
4. Once that admin holds a passkey, `FICUS_PASSWORD` stops being accepted as a
   login — human sign-in is passkeys only from then on.

If the passkey step fails, the account is created but has no passkey. The
browser is still signed in with the instance password. Ficus then shows **Finish
creating your admin account** instead of the app. Choose **Create passkey** or
**Retry** to register the passkey in the same window. You do not need a new
verification code. Ficus then signs you in to that account. See
[Finishing first-admin setup](core-auth.md#finishing-first-admin-setup).

Then point the CLI at it:

```bash
ficus auth login local --api-url http://localhost:3000
```

Until an admin has a passkey, `ficus` can authenticate from inside the checkout
using the bootstrap password in `.env`. After that, use browser-authorized CLI
login. If you exported `FICUS_PASSWORD` in your shell, unset it first so it does
not override browser authorization. `ficus auth status` shows the active source.

### AI provider

Sign in to a model provider in the web UI: **Settings > AI Providers** — API
keys, or the OAuth logins for ChatGPT Plus/Pro and GitHub Copilot
subscriptions. Anthropic takes an API key only. This needs `FICUS_ENCRYPTION_KEY`, which setup wrote for
you; without it saving credentials in AI Providers or Integrations fails with
`Cannot mutate secrets: FICUS_ENCRYPTION_KEY not configured`.
From the CLI, `ficus provider-auth set <provider> <key>` stores an API key
(`list`, `get`, `delete` and `oauth-providers` round out the command); the OAuth
subscription logins are web-UI only.

Optionally, agents can also use a Pi Coding Agent login on the host:

```bash
bun add -g @earendil-works/pi-coding-agent
pi
/login
```

Follow the prompts, then exit the session — the saved credentials are picked up
automatically. See the
[Pi Coding Agent quick start](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start).

### GitHub credentials for agents

Open **Settings > Integrations > GitHub > Settings > Connect account**.
Authorize the account and install the GitHub App on the repositories agents
should access. Account authorization alone does not grant repository access.
Standalone instances support device login; hosted instances return through the
Platform authorization broker.

In each squad's **Integrations** settings, check its selected or inherited
GitHub account and attach additional accounts when needed. Git and `gh` resolve
credentials for each operation, so account changes do not require restarting
agents. See [GitHub account connections](github-integrations.md) for CLI
connection and selection commands.

Legacy `GITHUB_USER`, `GITHUB_TOKEN`, `GH_TOKEN`, and per-squad token-secret
configuration are retired. Reconnect through Integrations; historical stored
values are not automatically deleted. Git commit author name and email are
separate from authentication: configure global overrides under **Settings >
Git**, or squad overrides under its **Integrations** settings.

### Optional services and keys

Agent-model login under **AI Providers** is separate from these optional API
services:

| Service             | Setup and scope                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI API services | **Settings > Integrations > OpenAI API services**: save an OpenAI API key and enable the integration for Realtime voice, audio transcription, and memory embeddings. ChatGPT subscription login does not supply this key. |
| Assistant & Memory  | **Settings > Assistant & Memory**: enable Voice assistant and Semantic memory search as desired. This page exposes the same OpenAI API-service connection.                                                                |
| Google Cloud speech | **Settings > Integrations > Google Cloud**: enable the integration and save service-account JSON with Text-to-Speech API access for message read-aloud. This is separate from OpenAI Realtime voice.                      |
| Brave search        | `BRAVE_SEARCH_API_KEY` enables the agent `web_search` tool; [get a key](https://brave.com/search/api/) and configure it in the server environment.                                                                        |

For OpenAI services-only setup, use the integration card. Exporting
`OPENAI_API_KEY` in the server environment also retains legacy agent-model
provider discovery behavior. Google speech alternatively supports a server-side
`GOOGLE_APPLICATION_CREDENTIALS` path for Application Default Credentials; the
Google Cloud integration must still be enabled.

There is no **Secrets & Keys** page. Saved integration secrets stay hidden;
enter a replacement to rotate them. OpenAI API-service and Google speech
credential changes apply to new requests without a restart. Restart with
`ficus server restart` after changing server environment settings.

### Browser tools

On the **`host` runtime** nothing is downloaded: the core drives a
Chrome/Chromium/Edge/Brave already installed on this machine, or the binary
named by `FICUS_BROWSER_EXECUTABLE_PATH` — see
[docs/wiki/host-runtime.md](host-runtime.md#browser-tools). Setup warns during
preflight when it cannot find one.

On the other runtimes the browser lives in the sandbox. Install it on the
machine host or bake it into the image:

```bash
cd apps/core && bunx playwright install chromium
```

Browser tools fail gracefully when no browser is available.

### Exposing it publicly

The core serves the app, `/api/*`, `/ws` and `/ws/terminal` on one port
(`FICUS_SERVE_WEB=1`, which setup writes), so a reverse proxy only has to forward
one origin. See
[Single-origin and reverse proxy deployment](reverse-proxy.md) for Caddy,
nginx, Traefik and Tailscale examples.

Passkeys are strict about the origin, and this is the common footgun:

- **`FICUS_WEB_ORIGIN`** must be the **bare origin** — `scheme://host[:port]`,
  **no path**. If the app is served under a base path
  (`APP_URL=https://home.example.com/ficus` with `APP_BASE_PATH=/ficus`), set
  `FICUS_WEB_ORIGIN=https://home.example.com`. WebAuthn rejects an origin with a
  path, which surfaces as a **500 on passkey registration**
  (`Unexpected registration response origin … expected …/ficus`). It also drives
  the CORS allowlist and the session-cookie SameSite/Secure choice.
- **`WEBAUTHN_RP_ID`** must be the **bare registrable domain**
  (`home.example.com` — no scheme, port or path). It defaults to the host of
  `FICUS_WEB_ORIGIN`, so set it only to pin a parent domain. A wrong RP ID makes
  registration fail.
- `--app-url` validates this at setup time and refuses anything that is not a
  bare origin.

Once the instance has a public URL, configure email (`AWS_SES_REGION` /
`SES_FROM_ADDRESS` plus AWS credentials, with the sender verified in SES) so
invited users receive their verification codes, and set `VAPID_SUBJECT` to a
real `mailto:` address if you want iOS/Safari push (Apple rejects `.local`
domains).

### Integrations

- **GitHub and Linear webhooks** — [docs/wiki/webhooks.md](webhooks.md)
  (webhook secrets, `gh`/UI setup, verification, event routing).
- **Discord / Slack / Telegram** — [docs/wiki/channels.md](channels.md): the
  consultant bot (slash commands, thread replies) and squad notifications for
  work streams that finish or need review.

## Manual setup reference

This is what `bun run setup` does, in case you want to do it by hand, script it
differently, or debug a step that failed:

1. **Clone and install.** `git clone --recurse-submodules …`, then `bun install`
   (which also initializes submodules).
2. **Config files.** `cp .env.example .env`; for PM2 also
   `cp ecosystem.config.example.js ecosystem.config.js` (the example carries the
   default instance's app names; for a labelled instance replace `ficus-api` /
   `ficus-worker` in it with `ficus-<label>-api` / `ficus-<label>-worker`, which is all
   setup's generation step does).
3. **`.env`.** Set `FICUS_SANDBOX_RUNTIME` (required — the api and worker refuse
   to start without it), `FICUS_ENCRYPTION_KEY` and `FICUS_INTERNAL_EVENT_TOKEN`
   (`openssl rand -hex 32` each), `FICUS_PASSWORD`, `PORT`, `WORKER_PORT`,
   `FICUS_WORKER_EVENT_PORT`, `FICUS_API_URL`, `APP_URL`, `FICUS_WEB_ORIGIN`,
   `DATABASE_URL`, `FICUS_SERVE_WEB=1`, `FICUS_UPDATE_SUPERVISOR`, the matching system-log provider/targets, and — for a
   labelled instance — `FICUS_INSTANCE`, `FICUS_PM2_API_NAME`,
   `FICUS_PM2_WORKER_NAME` and `HOME_DIR`. See
   [the managed-keys table](#what-it-writes) for the values setup picks.
4. **PostgreSQL.**
   `docker run -d --name postgres-ficus --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5432:5432 -v ficus_postgres-data:/var/lib/postgresql paradedb/paradedb:latest`
   (`docker start postgres-ficus` if that container already exists — one created
   by `docker compose` counts). Wait until
   `docker exec postgres-ficus psql -U postgres -tAc 'SELECT 1'` succeeds
   repeatedly (ParadeDB restarts once during first init), and create the
   database if it is not named `ficus`. A labelled instance uses
   `postgres-ficus-<label>`, the volume `ficus-<label>_postgres-data` and its own
   host port. Managed PostgreSQL works too — point `DATABASE_URL` at it and skip
   the container. pgvector, which memory search needs, is created by the
   migrations; nothing to install by hand.
5. **Migrate.** `FICUS_MIGRATE_LIVE=1 bun run db:migrate`. The flag is the
   explicit confirmation required to migrate the database configured by the
   repository-root `.env`; for a scratch database pass its `DATABASE_URL`
   inline instead.
6. **Build.** `bun run build:core && bun run build:cli && bun run build:web`.
7. **Sandbox runtime.** `docker-socket` / `docker-sysbox`:
   `bun run sandbox:build:docker`. k3d: `bun run k3d:setup` (creates the
   `ficus-dev` cluster, the `ficus-sandboxes-dev` namespace and the PVC, and imports
   the image). `host`: nothing. `k8s` and `vm` are not local installs — see
   [docs/wiki/k8s/deployment.md](k8s/deployment.md) and
   [docs/wiki/machines/runtime.md](machines/runtime.md).
8. **Start.** Use the recorded supervisor. PM2 starts its ecosystem and saves it; launchd uses `launchctl bootstrap gui/$UID` and systemd-user uses `systemctl --user enable --now`, always worker first and API last.
9. **Verify.** `curl http://localhost:3000/health`, then open the app.

## Verification checklist

```bash
# 1. The instance as ficus sees it: instance, supervisor, root, port, runtime, commit, process states, health
ficus server status

#    Every instance installed here (the other commands take --instance <label>)
ficus server list

# 2. API health — /health is public and returns 200 ({"status":"ok"})
curl -i http://localhost:3000/health

#    /api/* is auth-gated: 401 without a bearer token also proves the API is up
curl -i http://localhost:3000/api/health

# 3. Nothing crashing on boot
ficus server logs -n 50

# 4. The CLI talks to it (after the first admin exists)
ficus auth login local --api-url http://localhost:3000
ficus squad list

# 5. Integrations, if you configured them. These routes need the `webhooks:read`
#    permission: the bootstrap FICUS_PASSWORD works as a bearer token only until an
#    admin holds a passkey — after that, check them from a signed-in browser session.
curl -H "Authorization: Bearer $FICUS_PASSWORD" https://YOUR-DOMAIN/api/webhooks/github/status
curl -H "Authorization: Bearer $FICUS_PASSWORD" https://YOUR-DOMAIN/api/webhooks/channels/discord/status
```

Then open the app in a browser: the passkey flow, an AI provider signed in under
**Settings > AI Providers**, and one squad you can chat with is the real
end-to-end proof.

## Troubleshooting

| Problem                                                                             | Solution                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun is not installed and its installer needs unzip`                                | bun's installer unpacks a zip and stock Ubuntu/Debian images ship without `unzip`: `sudo apt install unzip` (Fedora: `sudo dnf install unzip`) and re-run, or install bun yourself first with `curl -fsSL https://bun.sh/install \| bash`.                                                                                                  |
| `Docker is required for …` (preflight)                                              | Install it — macOS: [Docker Desktop](https://docs.docker.com/get-docker/); Linux: `curl -fsSL https://get.docker.com \| sh`, then `sudo usermod -aG docker $USER` and log out and back in for the group change to take effect.                                                                                                              |
| `Preflight failed: docker info failed`                                              | Docker is installed but the daemon is not running — start Docker Desktop, or `sudo systemctl start docker`. Docker is only needed for the managed PostgreSQL container and the container runtimes; `--runtime host` with `--database-url` pointing at an existing PostgreSQL needs none.                                                    |
| `pm2 already runs ficus-api for instance "<label>" from another checkout`           | Another checkout is running this instance's pm2 apps. Give this one its own label (`--instance <other-label>`), or unregister the other (`ficus server uninstall --root <that checkout>`). Only online pm2 apps block; stopped ones are ignored. See [Multiple instances](#multiple-instances).                                             |
| `this checkout is instance "<x>"; to relabel it, remove FICUS_INSTANCE from .env`   | A checkout belongs to one instance. Re-run without `--instance` to keep it as it is, use a fresh checkout for the new label, or genuinely relabel this one: `ficus server uninstall --root <root>` (supervisor registration + registry entry), then delete `FICUS_INSTANCE` from its `.env`. See [Multiple instances](#multiple-instances). |
| `this checkout's DATABASE_URL points at a Postgres the installer does not manage …` | The DSN in `.env` is on loopback but is not this instance's container (its credentials differ), so `--db-port` / `--db-name` cannot apply to it. Pass `--database-url` to point at the database you want, or remove `DATABASE_URL` from `.env` and let setup manage a container.                                                            |
| `unknown instance "<label>" — known instances: …`                                   | `--instance` (or `FICUS_INSTANCE`) names a label the registry does not hold. `ficus server list` shows the labels it knows; run setup in that checkout to register it, or address it with `--root <dir>`. See [Multiple instances](#multiple-instances).                                                                                    |
| `port <n> is in use but is not container postgres-ficus…`                           | The port this checkout's `DATABASE_URL` names is taken by something that is not this instance's container. Stop that listener, pass the `--db-port <n>` the message suggests, or point `--database-url` at the database you actually want.                                                                                                  |
| `container postgres-ficus… publishes <x>, not <y>`                                  | A container's port mapping is fixed when it is created, so `--db-port` cannot move it. Re-run with `--db-port <x>`, or remove the container (`docker rm -f <container>`, keeping the volume) and let setup recreate it on the port you want.                                                                                                |
| `FICUS_SANDBOX_RUNTIME must be one of …`                                            | The value is unset or an old spelling. Old spellings were removed, not aliased: `sysbox` → `docker-sysbox`, `socket` → `docker-socket`, `auto` / `docker` → choose `docker-sysbox` or `docker-socket` explicitly. Fix `.env`, then `ficus server restart`.                                                                                  |
| `bun: command not found`                                                            | `curl -fsSL https://bun.sh/install \| bash`, then re-open the shell.                                                                                                                                                                                                                                                                        |
| Preflight says bun is older than the pinned version                                 | `bun upgrade` (the pin is the checkout's `.bun-version`).                                                                                                                                                                                                                                                                                   |
| `This installer supports macOS or Linux (got win32)`                                | Windows runs through WSL 2: from PowerShell run `wsl --install -d Ubuntu-24.04`, reboot, then inside WSL run the installer (`curl -fsSL https://ficus.sh/cli/setup.sh \| bash`).                                                                                                                                                            |
| Warning: `tmux is not installed — agents cannot run local deployments until it is`  | A `host`-runtime warning, not a failure: setup continues, but agents cannot run local deployments until tmux is installed (macOS: `brew install tmux`; Debian/Ubuntu: `sudo apt install tmux`).                                                                                                                                             |
| `docker-sysbox requested but the sysbox runtime is not installed`                   | Run `ficus server bootstrap-sysbox` (consent-gated automation; inside WSL enable systemd first — see [docs/wiki/sandbox-runtimes.md](sandbox-runtimes.md#installing-sysbox)), or choose `docker-socket`.                                                                                                                                    |
| `k3d is required for the k3d runtime`                                               | `brew install k3d kubectl` (or see [k3d.io](https://k3d.io)), then re-run setup.                                                                                                                                                                                                                                                            |
| The API did not answer `/health` within 60s                                         | `ficus server logs -c api -n 100` — a missing `.env` value or a failed migration is the usual cause.                                                                                                                                                                                                                                        |
| Database connection error                                                           | `docker ps --filter name=postgres-ficus` — this instance's container (`postgres-ficus`, or `postgres-ficus-<label>`) must be up on the port `DATABASE_URL` names. `ficus server start` starts it for you when the DSN is one the installer wrote.                                                                                           |
| Collation version mismatch                                                          | `docker exec postgres-ficus psql -U postgres -d ficus -c "ALTER DATABASE ficus REFRESH COLLATION VERSION;"` (`postgres-ficus-<label>` for a labelled instance) — happens when the Docker image updates glibc.                                                                                                                               |
| Migration fails                                                                     | PostgreSQL must be reachable and `DATABASE_URL` correct; migrating the root `.env` database needs `FICUS_MIGRATE_LIVE=1`.                                                                                                                                                                                                                   |
| `Cannot mutate secrets: FICUS_ENCRYPTION_KEY not configured`                        | `.env` has no encryption key: `echo "FICUS_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env`, then `ficus server restart`.                                                                                                                                                                                                                   |
| API returns 401 from the CLI                                                        | Run `ficus auth status`, then `ficus auth login local --api-url http://localhost:<port>`. Clear a stale shell `FICUS_PASSWORD` for browser login; the checkout password works only before an admin has a passkey.                                                                                                                           |
| Passkey registration returns 500                                                    | `FICUS_WEB_ORIGIN` contains a path, or `WEBAUTHN_RP_ID` is wrong — see [Exposing it publicly](#exposing-it-publicly).                                                                                                                                                                                                                       |
| `<root> has uncommitted changes` from `ficus update`                                | The offline updater refuses a dirty tree. Commit or discard the changes, then retry.                                                                                                                                                                                                                                                        |
| Webhook 401 / 404                                                                   | 401: the secret in `.env` and the one on the provider differ. 404: the provider is not registered — check that the api started cleanly.                                                                                                                                                                                                     |
| Voice, memory search, or TTS not working                                            | Check Integrations > OpenAI API services and Assistant & Memory feature switches for voice/embeddings; check Integrations > Google Cloud and its JSON/ADC credentials for message read-aloud.                                                                                                                                               |
| Agent runs fail immediately                                                         | Sign in to a provider under **Settings > AI Providers**, or install and authenticate Pi (`bun add -g @earendil-works/pi-coding-agent`, then `pi` and `/login`).                                                                                                                                                                             |
