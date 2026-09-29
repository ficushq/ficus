# Ficus setup toolkit

Takes a fresh host from **nothing → a running Ficus** whose only remaining step
is a human opening a URL and creating the first admin passkey. Config-driven,
idempotent (every script is safe to re-run), and headless-friendly — this is
the per-tenant provisioning primitive a future cloud control-plane calls.

```
scripts/setup/
  ficus-setup.example.yaml       the TENANT config contract (fully commented)
  setup-host.sh                  ON-TARGET primitive: runs ON a fresh Ubuntu 24.04 host
  upgrade-host.sh                ON-TARGET primitive: moves an ALREADY SET UP host to another
                                 source ref (sync → build core+web → migrate → restart). Needs
                                 no secrets — the host's .env already has them. Driven by the
                                 control plane's `upgrade` job, also runnable by hand.
  provision.sh                   ORCHESTRATOR: VM (exe, hetzner, or digitalocean) → setup-host.sh over SSH
  provision-exe.sh               compat shim → provision.sh (kept for old bookmarks/muscle memory)
  seed.sh                        idempotent API seeding (called by setup-host.sh,
                                 also usable standalone against a running instance)
  ficus-backup.sh.tmpl           rendered → the nightly backup script (optional, backup.enabled)
  lib.sh                         shared helpers (logging, retry, config, http, git source, caddy, wizard)
  systemd/ficus-api.service.tmpl    rendered → the api unit under /etc/systemd/system
  systemd/ficus-worker.service.tmpl
  systemd/ficus-backup.service.tmpl rendered → the backup .service and .timer
  systemd/ficus-backup.timer.tmpl
```

The setup and provisioning scripts install a complete Ficus instance: API, worker, database, sandbox runtime, and initial squad.

## Quickstart

### Path A — cloud VM, from your laptop

```bash
# 1. Generate a config (interactive; writes ./ficus-setup.yaml, never stores secrets)
scripts/setup/provision.sh --wizard

# 2. Review the plan
OPENAI_API_KEY=sk-... scripts/setup/provision.sh --config ficus-setup.yaml --dry-run

# 3. Go
OPENAI_API_KEY=sk-... scripts/setup/provision.sh --config ficus-setup.yaml
```

This creates the VM, waits for SSH, pushes the toolkit + config + key files
(`COPYFILE_DISABLE=1`, never the source tree — see Pitfalls), runs
`setup-host.sh` remotely, and prints the handoff URL. `provision.provider`
picks the VM provider:

- **exe** (default) — `ssh exe.dev new --name <n> --image ghcr.io/ficushq/ficus-machine:latest`;
  the VM is reachable at the stable `<name>.exe.xyz` hostname before it even exists.
- **hetzner** — creates (or reuses, by name) a Hetzner Cloud server via the
  hcloud API (`provision.hetzner.{server_type,location,image,ssh_key_name}`),
  polls until it's running, and SSHes to its public IP directly (not DNS,
  which may not have propagated yet). `provision.ssh_user` defaults to
  `root`. Pair it with `dns.provider: cloudflare` + `dns.zone` to
  upsert a **proxied** A record for `core.origin`'s host → the server's IP
  (proxied because the origin serves a Cloudflare Origin CA certificate — see
  the TLS bullet below).
  Needs `$HCLOUD_TOKEN` (and `$CLOUDFLARE_API_TOKEN` if DNS is on) on the
  control machine only — never forwarded to the target. See
  `ficus-setup.example.yaml` for the full contract.
- **digitalocean** — creates (or reuses, by tag + exact name) a Droplet via
  the DO API (`provision.digitalocean.{size,region,image,ssh_key_id}`),
  polls until it's `active` with a public IPv4 (`networks.v4[].type ==
"public"` — DO always returns both a public and private entry), and SSHes
  to that IP directly (not DNS). Supports an OPTIONAL ordered
  `provision.digitalocean.fallbacks` list of alternate `{size, region}`
  pairs, tried in turn on a capacity/availability error (422/503) — never on
  an auth/image/other error — so a temporarily-out-of-stock size/region
  doesn't fail a paid signup. Two more OPTIONAL knobs:
  `provision.digitalocean.vpc_uuid` pins the droplet to a specific VPC rather
  than whichever one is currently the region's default (needed whenever the
  droplet must reach a private-network endpoint, e.g. a managed database),
  and `provision.digitalocean.project_id` files it under a DO project via a
  separate post-create call that is best-effort by design — the droplet
  already exists and is already billing by then, so a failed assignment warns
  and continues rather than failing the run. This is the provider the hosted platform
  actually uses: Hetzner's cheap shared-vCPU tiers (CX23/CAX11) are
  frequently unbuyable (no capacity). `provision.ssh_user` defaults to
  `root`. Pair it with `dns.provider: cloudflare` + `dns.zone` the same way
  as hetzner. Needs `$DIGITALOCEAN_TOKEN` (and `$CLOUDFLARE_API_TOKEN` if
  DNS is on) on the control machine only — never forwarded to the target.
  See `ficus-setup.example.yaml` for the full contract.

### Path B — any Ubuntu 24.04 host, on the host itself

```bash
scripts/setup/setup-host.sh --wizard                       # or write ficus-setup.yaml by hand
OPENAI_API_KEY=sk-... scripts/setup/setup-host.sh --config ficus-setup.yaml --dry-run
OPENAI_API_KEY=sk-... scripts/setup/setup-host.sh --config ficus-setup.yaml
```

### Upgrading a host that is already set up

```bash
# ON the host (root), against the config it was set up with:
GH_TOKEN=ghp_... scripts/setup/upgrade-host.sh --config /root/ficus-setup/ficus-setup.yaml --ref main
```

Source sync → `bun install` → **core build** → web build → migrations →
`systemctl restart ficus-api ficus-worker` (the host layout's unit names) +
health wait. `--ref` takes a branch,
tag or commit sha and defaults to the config's `source.ref`.

Before either tenant setup or upgrade builds, the toolkit reconciles swap and
manages root-owned `/usr/local/bin/bun` plus
`/usr/local/bin/node -> /usr/local/bin/bun`. It verifies a real Node shebang as
`core.run_user`; hosted tenants omit that key and therefore preserve their
root SSH/setup/upgrade identity. For a supported BYO non-root upgrade, the
invoking operator must either be root or have non-interactive sudo, the
configured `core.run_user` account must already exist, and Bun source discovery
must succeed from the invoking operator's `PATH` or `HOME/.bun/bin`; setup then
copies that executable into the managed system path before switching identity.
Host migrations (below) are root-only: a non-root run takes no migration
lock (it warns instead) and goes on exactly as before as long as the host
needs no host migration, restore or reconcile. When it would have to run one,
finish a journaled one, or restore a set (`--restore-host-backup`), it stops
before changing anything and says so: re-run it as root.

Do NOT hand-roll this sequence. The api unit runs `bun run dist/index.js`, so a
fetch without the core build leaves the OLD server running while `git log` on
the box shows the new commit — a failure that looks exactly like a successful
deploy. `upgrade-host.sh` and `setup-host.sh` both go through `lib.sh`'s
`build_app`, which is what makes skipping the build impossible rather than
merely discouraged.

The control plane drives this same script over SSH for its `upgrade` job
(the hosted control plane's admin "Upgrade" / "Upgrade all"), and independently verifies
afterwards that `apps/core/dist/index.js` was rebuilt and that the running
api process started after it.

### Hosts and archives from before the Ficus naming

This toolkit and the Core releases it installs read `FICUS_*` settings only.
A host whose `<dest>/.env` still holds its encryption key under the pre-Ficus
prefix (`<OLD>_ENCRYPTION_KEY`, where `<OLD>` is `lib.sh`'s
`PRE_FICUS_ENV_PREFIX`) predates that naming: `upgrade-host.sh`,
`setup-host.sh`, `apply-artifacts.sh --config` and the retarget primitives
refuse it in preflight, write nothing, and name the key. Upgrade such a host
through the `ficus-rename-bridge` Core release first; it renames the host's
settings with a journaled backup. `setup-host.sh` never generates a new
`FICUS_ENCRYPTION_KEY` beside an old one. Any other `<P>_ENCRYPTION_KEY` (an
app's own setting) is not checked. A target release that predates the
naming (an artifact without `"envPrefix": "FICUS"`, or a checkout whose
`package.json` is not named `ficus`) is refused too.

A backup archive taken before the Ficus naming carries its key under the old
prefix, and a restore from it stops with that key's name. Rename the
archive's `.env` keys by hand (in the unpacked archive), then retry:

```bash
sed -i 's/^\(export \)\{0,1\}<OLD>_/\1FICUS_/' .env
```

### Host migrations

When a release needs this host's config files changed (`<dest>/.env`,
`managed.env`, `backup.env`, the config, the core units and their drop-ins,
the backup service and timer, the installed backup script), `lib.sh`'s
journaled host-migration framework
does it: right before the `current` symlink moves (artifact mode) or before
the restart (git mode). This release registers one migration, `host_layout`:
the move to the Ficus host layout.

- **Backup sets.** Before the first change, every host config file is copied
  byte for byte (`cp -p`, verified with `cmp`, sha256 recorded in a
  `MANIFEST`) into `/var/backups/ficus-host-migrate/<UTC time>-<random>/`
  (override: `HOST_MIGRATE_BACKUP_ROOT`). **These sets hold plaintext
  secrets.** The directory is root 0700, and the newest five sets are kept.
  A file the migration may create is recorded in an `ABSENT` list, and a
  restore removes it again.
- **The journal.** `/var/backups/ficus-host-migrate/PENDING` names the set,
  the migrations and the release; it is flushed to disk before the first
  change and removed once that release is serving (or after a verified
  restore).
- **The files follow the active release.** When a run fails or is signalled
  (`SIGTERM` / `SIGHUP` / `SIGINT`) after migrating, the files are made to
  match the release that is serving at that moment: restored byte for byte
  while the old release serves (or after the automatic rollback), finished
  and committed once the new one does.
- **Migrations that change more than files.** A migration that moves
  directories, links, units or data defines two more hooks: `_settle`, which
  decides by its own commit point (not the serving release) whether a
  journaled run is finished forward or undone, and `_reverse`, which undoes
  the moves before the files are restored. Its backup set starts its
  `MANIFEST` with a `#requires-reverse` line, and a byte restore of such a set
  is refused — whoever asks — until the same run has reversed every migration
  that line names (even one the journal does not list).
- **Reconcile.** A run that could not settle (`SIGKILL`, OOM, reboot) leaves
  the journal; the next `upgrade-host.sh`, `setup-host.sh` or
  `apply-artifacts.sh --config` settles it the same way. Those runs take an
  exclusive `flock` on `/var/backups/ficus-host-migrate/.lock` first, when
  run as root (wait capped at 900 s, `HOST_MIGRATE_LOCK_WAIT`).

**`--restore-host-backup <set>`** is the manual way back:

```bash
sudo bash scripts/setup/upgrade-host.sh --config /root/ficus-setup/ficus-setup.yaml \
  --restore-host-backup /var/backups/ficus-host-migrate/<set>
```

It verifies every file against the set's `MANIFEST`, puts it back, clears the
journal if it names that set, and exits. It refuses a set marked
`#requires-reverse` (see above), changing nothing. It also accepts the sets the
previous release left under `/var/backups/ficus-env-rename/` (read only;
nothing writes there any more). It reverts **any secret changed since that set
was taken**, and it is root-only.

### The host layout

Where a host keeps its install root, `/etc` dir, setup dir, units, backup
script, `HOME_DIR` and container database is resolved once per run from what
is installed (`lib.sh`'s host layout section), never assumed:

|                                                            | layout 1 (before the Ficus host migration) | layout 2 (Ficus)                                            |
| ---------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| install root                                               | the legacy `/opt/<old>-core`               | `/opt/ficus-core`                                           |
| `/etc` dir (CA, `managed.env`, `artifacts/`, `backup.env`) | the legacy one                             | `/etc/ficus`                                                |
| setup dir, config                                          | the legacy ones                            | `/root/ficus-setup/ficus-setup.yaml`                        |
| units                                                      | the legacy names                           | `ficus-api`, `ficus-worker`, `ficus-backup.{service,timer}` |
| backup script                                              | the legacy name                            | `/usr/local/bin/ficus-backup.sh`                            |
| `HOME_DIR` default                                         | `<run user home>/.<old>`                   | `<run user home>/.ficus`                                    |
| container database                                         | the legacy container, volume and name      | `ficus-postgres`, `ficus-pgdata`, `ficus`                   |

A host is on layout 2 once `/etc/systemd/system/ficus-api.service` is a
regular file, on layout 1 while only the legacy api unit exists; a fresh host
is set up on layout 2. The unit templates carry the layout as tokens
(`@ETC_DIR@`, `@UNIT_API@`, `@UNIT_WORKER@`, `@UNIT_BACKUP@`, `@ALIAS@`, and
`@DB_NAME@` in the backup script), so a layout-1 host renders exactly the
units it always had.

**The move.** A release that declares `hostLayout: 2` (`artifact.json`; a git
checkout: root `package.json` `ficusHostLayout: 2`) moves a layout-1 host to
layout 2 through the `host_layout` host migration, right before the flip
(git mode: before the restart; `setup-host.sh`: before its `.env` phase). It
stops the backup timer and both units, moves the install root, `/etc` dir,
setup dir and `HOME_DIR` (leaving a compat symlink at each legacy path),
rebases the database rows that store absolute `HOME_DIR` paths (the release's
`dist/rebase-home.js`), renames the units (each keeps its legacy name as an
`Alias=`), the backup script (a compat link), the update sudoers rule and, in
container mode, the database container, volume and name. Every step is
journaled in the framework's backup set (`<set>/hl/`), intent first, and
logged as `host_layout S<n>: …`. The last trailer line of `upgrade-host.sh` is
`FICUS_HOST_LAYOUT=<1|2>`.

- **Before its commit point** (`hl/DONE`), any failure, signal or `SIGKILL` is
  reversed: the host is put back byte for byte and the legacy units are
  started again.
- **After it, the move is kept** — also when the release is rolled back: the
  older release runs on layout 2 through the compat links and `Alias=` names.
  Both units are stopped before any flip across the layouts (they use
  different admission-lock keys).
- A git mode run as non-root on a layout-1 host refuses a revision that
  declares layout 2 before its checkout moves (the move is root-only).
- A host set up fresh on layout 2 whose external database DSN still names the
  CA under the legacy `/etc` dir (a stored tenant DSN; the control plane
  rewrites it to `/etc/ficus` when it renames the tenant database) gets the
  same compat link a migrated host has (legacy `/etc` dir → `/etc/ficus`), so
  the DSN resolves until it is rewritten.
- An older toolkit that writes over the bridges (a regular legacy unit file
  where the `Alias=` link was) is repaired by the next run of this one.

**`--reverse-host-layout <set>`** is the manual way back after the commit
point, once the release serving is from before the move again (roll back
first):

```bash
sudo grep -l "$(printf '^#requires-reverse\thost_layout')" /var/backups/ficus-host-migrate/*/MANIFEST
sudo bash scripts/setup/upgrade-host.sh --config /root/ficus-setup/ficus-setup.yaml \
  --reverse-host-layout /var/backups/ficus-host-migrate/<set>
```

It takes only the latest set that reached its commit point and was not
reversed since (`hl/DONE` without `hl/REVERSED`), refuses while another
run's journal is pending, and is root-only. It moves everything back, rebases
the stored `HOME_DIR` paths back, then restores the set's files byte for byte
— **which reverts any change made to them since the move** (re-run the
artifact sync afterwards). On a container database it also returns to the
legacy volume as it was at the move, losing every write since, and needs
`--accept-database-revert`. It is journaled: a reverse that is killed half way
is finished by the next toolkit run, or by running it again. A set marked
`#requires-reverse` is never byte-restored by `--restore-host-backup`.

### What you end up with (the contract)

1. Core API healthy (`GET /health` → **401 means up**: healthy + auth-gated),
   DB migrated, web UI served from the core process at ONE origin.
2. `APP_URL` = `FICUS_WEB_ORIGIN` = `core.origin` — the exact browser-facing
   origin, no path. This is what makes passkeys work.
3. AI provider account + `exe-provider-ssh-key` secret + starter squad with one
   agent, seeded through the API with the `FICUS_PASSWORD` bootstrap bearer.
4. `ficus-api` + `ficus-worker` under systemd (auto-restart, survive reboot,
   `journalctl -u ficus-api`; the host layout below). The in-UI Restart (`POST /api/system/restart`)
   restarts BOTH units: the api signals the worker over the internal event
   transport, and each exits non-zero so `Restart=on-failure` brings it back.
5. A printed URL + instruction: open it, register the first admin passkey.
   The bootstrap bearer is fully privileged **only while no admin exists** and
   disables itself the instant that passkey is created — nothing to revoke.

## The config file

See [`ficus-setup.example.yaml`](ficus-setup.example.yaml) — every field is
commented there. Ground rules:

- **`runtime.sandbox` is required and has no default.** It is exactly one of
  `docker-sysbox`, `docker-socket`, `k8s`, `vm`, or `host`, and it becomes
  `FICUS_SANDBOX_RUNTIME` in the generated `.env`. A config without it is a hard
  error before the host is touched, and the wizard prompts for it with no
  default — the core itself refuses to start without the variable, so there is
  nothing sensible to guess. See
  [`docs/wiki/sandbox-runtimes.md`](../../docs/wiki/sandbox-runtimes.md) to choose.
  `runtime.exe.*` (`ssh_key_path`, `machine_image`) applies only to
  `sandbox: vm` with exe.dev boxes; `sandbox: k8s` assumes a cluster this
  toolkit does not build.
- **Secrets never live in the yaml.** API keys come from env vars
  (`ai.key_env`), SSH keys from file paths, tokens from `GH_TOKEN`; anything
  missing is prompted for when a TTY is available and is a hard, early error
  when not (unattended runs fail fast, before touching the host).
- `secrets.encryption_key_env` / `secrets.password_env` name env vars for
  `FICUS_ENCRYPTION_KEY` / `FICUS_PASSWORD`; unset means _generate_. Re-runs reuse
  the values already in `<dest>/.env` — regenerating the encryption key would
  orphan the encrypted secret store.
- Headless setup **requires an api-key provider** (`openai` or `anthropic`).
  `openai-codex` needs an interactive ChatGPT OAuth login: setup warns, skips
  key seeding, and tells you to finish in Settings > AI Providers after the
  passkey handoff. The starter agent's `model` must match the seeded provider
  (guarded — `openai-codex:*` models are rejected with api-key providers).
- `source.mode: artifact` — a tenant-only seam driven by a cloud control
  plane, not by hand. Instead of cloning, `setup-host.sh` downloads a signed,
  prebuilt release bundle, verifies it, and stages it under
  `<dest>/releases/<sha>-<digest12>` — `artifact_acquire` → `artifact_stage`
  → `artifact_activate`, the same acquire/stage/activate primitives
  `upgrade-host.sh` uses for fleet upgrades (activation migrates, flips
  `<dest>/current`, restarts, health-checks, and auto-rolls-back on a failed
  check). The four inputs (`FICUS_ARTIFACT_TARBALL_URL`,
  `FICUS_ARTIFACT_MANIFEST_URL`, `FICUS_ARTIFACT_SIG_URL`,
  `FICUS_ARTIFACT_PUBKEY_B64`) arrive via the ENVIRONMENT (the control plane's
  `secrets.env` channel), never the config file — three of them are
  presigned GET credentials. All four are required: a partial set dies
  naming exactly what's missing rather than silently falling back to a
  source build. `source.repo`/`source.ref` stay required even in this mode
  (recorded metadata; there is no checkout to clone). The build and migrate
  phases are no-ops in this mode — the release ships prebuilt, and
  migrations run inside `artifact_activate`.

- `ingress.caddy` (default `false`) turns on a flag-gated ingress step: setup
  installs caddy and writes `/etc/caddy/Caddyfile` with a single vhost that
  terminates TLS for `core.origin`'s host and reverse-proxies to
  `127.0.0.1:<core.port>`. Caddy owns 443, so `core.origin` must be
  portless `https://...` when this is on — `setup-host.sh` refuses to start
  with a clear error otherwise. This is the shape the cloud control plane
  renders for tenant VMs.
- **TLS is a supplied certificate, never ACME.** `ingress.tls_cert_path` /
  `ingress.tls_key_path` (both required when `ingress.caddy: true`) point at a
  Cloudflare Origin CA cert+key pair; the rendered vhost is `tls <cert> <key>`
  and there is no ACME and no global email block anywhere. Two reasons, neither
  negotiable:
  - Let's Encrypt allows **50 certificates per registered domain per week**,
    shared across every `*.ficus.sh` subdomain. Per-tenant ACME therefore
    caps signups at 50/week, and issuance happens _after_ payment — a
    rate-limited failure is a paid-but-broken tenant.
  - An Origin CA certificate is trusted by **Cloudflare's proxy only**, never
    by a browser, so the hostname MUST be proxied (orange cloud).
    `provision.sh` creates its A records with `proxied: true` for exactly this
    reason; a grey-cloud record would both break TLS for real browsers and
    publish the origin IP.

  One pair covers the apex and `*.<zone>` and is valid for years, so nothing
  does per-host issuance or renewal, and port 80 is neither used nor opened
  (there is no HTTP-01 challenge). `provision.sh` delivers the pair to tenant
  VMs the same way it delivers the git deploy key — `scp` into
  `<remote dir>/keys/` at 0600, config paths rewritten to match —
  and `setup-host.sh` installs them to `/etc/caddy/tls/origin.{crt,key}` (key
  0600, owned by the `caddy` service user). The key's contents are never
  logged, echoed, or printed by `--dry-run`.

- **An external database is verified, not merely encrypted.**
  `database.ca_path` points at the CA that signed the database server's
  certificate, on the machine running the script. It rides the exact same
  delivery path as the origin cert (scp into `<remote dir>/keys/`, config value
  rewritten to match) and `setup-host.sh` installs it at
  `/etc/ficus/database-ca.crt` (the host layout's etc dir) — **0644, root-owned**, deliberately unlike the
  origin key, because a CA certificate is a public document with several
  unprivileged readers (the api/worker units, the nightly
  `pg_dump`).

  Required whenever the DSN uses `sslmode=verify-full`, and both scripts refuse
  to proceed without it: `provision.sh` asserts the file exists **and is
  readable by the invoking user** before any VM is created, and `setup-host.sh`
  re-checks before it mutates the host. `require` on its own encrypts but
  authenticates nothing — anything able to intercept the connection can present
  its own certificate — and managed providers sign with a private CA that is in
  no system trust store, so the file has to be supplied.

- The generated `.env` always includes `FICUS_SYSTEM_LOG_PROVIDER=systemd`, so
  Settings → System Logs streams from journald on toolkit installs (the units
  default to the api/worker unit names; see `docs/wiki/system-logs.md`). Installs
  created before this line existed must add it to `<dest>/.env` by hand and
  restart both services.
- The generated `.env` also carries `FICUS_WORKER_EVENT_PORT=3003` and a
  generated `FICUS_INTERNAL_EVENT_TOKEN`. The api and worker units exchange agent
  control signals, forwarded events and secret-cache invalidations over
  loopback HTTP (the worker's listener binds `127.0.0.1` only); the token
  authenticates both directions and MUST be identical in both units, which is
  exactly why it lives in the `.env` they share. Re-runs preserve an existing
  token; rotating it is harmless because both units restart together. Installs
  created before these lines existed can add it by hand (`openssl rand -hex 32`)
  or rely on the HMAC-derived token when both units share `FICUS_ENCRYPTION_KEY`.
  Only when both values are absent does each process generate a random token and
  reject cross-process events. Override
  the port via `core.env` if 3003 is taken on the host.
- `core.env` (default `{}`) is a flat string map appended verbatim to
  `<dest>/.env`, after the built-ins — the knob a future cloud control plane
  uses to inject per-tenant settings (e.g. `FICUS_MAX_MACHINES` tier limits)
  without a bespoke config field per knob. Keys must be
  `SCREAMING_SNAKE_CASE`. A key ending in `_ENV` follows the same secret
  indirection convention as `secrets.encryption_key_env`: the yaml names an
  env var (never the secret itself), and the rendered line drops the `_ENV`
  suffix and takes that var's content —
  `FICUS_PLATFORM_USAGE_TOKEN_ENV: PLATFORM_USAGE_TOKEN` renders
  `FICUS_PLATFORM_USAGE_TOKEN=<contents of $PLATFORM_USAGE_TOKEN>`. Setup dies
  fast (before touching the host) on an invalid key, a value with an embedded
  newline, or a `_ENV` reference to an unset variable — and on any attempt to
  override a built-in (`APP_URL`, `FICUS_WEB_ORIGIN`, `DATABASE_URL`,
  `FICUS_ENCRYPTION_KEY`, `FICUS_PASSWORD`, `FICUS_INTERNAL_EVENT_TOKEN`), which
  always wins. See
  `ficus-setup.example.yaml` for the full contract.
- `backup.enabled` (default `false`) turns on a flag-gated nightly encrypted
  backup: setup renders the backup script under `/usr/local/bin` (from
  `ficus-backup.sh.tmpl`) plus a backup timer (`backup.schedule`, `HH:MM`
  UTC) that triggers the backup service. Each run: `pg_dump -Fc` (via
  `docker exec ficus-postgres` in `database.mode: container`, else the DSN from
  `<dest>/.env`), tars it together with **`HOME_DIR`** (the agent
  workspace/memory tree — resolved the same way `apps/core` resolves it:
  `core.env.HOME_DIR` if set, else `<core.run_user's home>/.ficus`) **and
  `<dest>/.env`** (the backup envelope carries `FICUS_ENCRYPTION_KEY` itself,
  by design — never the platform's tenant registry), encrypts the tarball
  with `openssl enc -aes-256-cbc -pbkdf2` using a passphrase, and uploads it
  to `<backup.s3_prefix>/<YYYY-MM-DD>.tar.gz.enc` via
  `curl --aws-sigv4 "aws:amz:<backup.s3_region>:s3"`. Prunes local temp files
  and keeps only the last 14 objects under the prefix (S3 `ListObjectsV2` +
  `DELETE` of the rest). S3 credentials and the passphrase are resolved from
  the env vars named by `backup.s3_access_key_env` /
  `backup.s3_secret_key_env` / `backup.passphrase_env` (the same `*_env`
  indirection convention used elsewhere — never stored in the yaml) and
  rendered into a 0600 root-owned `/etc/ficus/backup.env` that only the
  rendered script reads; they never touch curl argv, logs, or the tenant
  `.env`. Non-zero exit on any failure (systemd flags the unit as failed).
  See `ficus-setup.example.yaml` for the full contract. `bash
scripts/setup/ficus-backup.test.sh` round-trip-tests the rendered script
  (tar → encrypt → decrypt → untar) against a scratch dir with a fake
  `pg_dump` (the `FICUS_BACKUP_PG_DUMP_CMD` seam) — no live postgres or S3
  needed.

**Dependency:** config parsing uses **mikefarah yq v4** (one flavor, one
syntax; the python jq-wrapper `yq` is rejected). `setup-host.sh` auto-installs
it on the Linux target; on a control machine: `brew install yq`.

## Idempotency (safe re-run)

| Phase                                       | Re-run behavior                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source                                      | clone → `fetch` + `checkout` of the configured ref                                                                                                                                          |
| database                                    | container + volume reused; password recovered from `<dest>/.env`; the database created only if missing                                                                                      |
| .env                                        | rewritten, but existing secret values are preserved                                                                                                                                         |
| systemd                                     | units re-rendered, `daemon-reload`, `restart`                                                                                                                                               |
| caddy (optional, `ingress.caddy`)           | Caddyfile rewritten and caddy `reload`d (never restarted) only when its content changed; the origin cert/key are re-installed to `/etc/caddy/tls/`                                          |
| Stripe webhook (optional, `stripe.enabled`) | endpoint looked up by URL: created only if absent, updated only if its event list drifted or Stripe disabled it, otherwise untouched; the signing secret already on file is carried through |
| backup (optional, `backup.enabled`)         | script/env-file/units re-rendered, `daemon-reload`, `enable --now` (idempotent — arming an already-armed timer is a no-op)                                                                  |
| seed                                        | check-before-create (provider account, squad, agent); total no-op once an admin exists (the bearer is dead by then)                                                                         |

Every wait is a bounded poll on a real condition (`pg_isready`, `docker info`,
`/health` → 200/401, `systemctl is-active`) — never a fixed sleep. Failures
tail journald so you see _why_. (The platform app is different: it really

## seed.sh standalone

Re-seed (or seed a manually-installed instance) without re-running setup:

```bash
scripts/setup/seed.sh --config ficus-setup.yaml \
  --env-file /opt/ficus-core/.env --api-url http://127.0.0.1:3000
```

## Pitfalls this toolkit encodes (hit live, 2026-07-14)

- **Never tar/scp the source tree from macOS.** AppleDouble `._*` files carry
  xattrs with NUL bytes that crash config-sync's YAML parser and boot-loop
  core. Source always arrives via `git clone` on the target; the orchestrator
  only pushes the small config/key files, with `COPYFILE_DISABLE=1`.
- **Build before start.** systemd runs `bun run dist/index.js|worker.js` — the
  production path. `bun run src/*.ts` is not it.
- **`bun install --ignore-scripts`** — skips the root postinstall (submodules +
  extensions); bun-pty is externalized from the core build so the runtime
  doesn't need it vendored. `bun run extensions:install` is run explicitly.
- **`FICUS_WEB_ORIGIN` must equal the browser origin** (no path!) or WebAuthn
  fails silently. The origin format is validated; for exe that is
  `https://<vm>.exe.xyz:<port>` — the proxy origin, not localhost.
- **The ficus-machine image masks rootful docker** (box hardening). The CORE host
  is not a box host, so `setup-host.sh` unmasks it for the local DB container —
  intentional and correct.
- **openai-codex cannot be seeded headless** (OAuth, not api-key) — see above.

## Seams (designed, not yet implemented)

- `provision.provider` — `provision_vm()` in provision.sh dispatches per
  provider; `exe`, `hetzner`, and `digitalocean` are implemented (more slot
  in there).
- `dns.provider` — `dns_upsert_a_record()` in provision.sh dispatches per
  provider; `cloudflare` is the only implementation today.

## Relationship to other deploy paths

- `docs/wiki/setup.md` — local development (pm2 + a local sandbox runtime) and
  integrations; points here for production single-host setup.
- `scripts/deploy.sh` + `docs/wiki/k8s/deployment.md` — the Kubernetes deployment
  path (untouched by this toolkit).
- **Sandbox runtime is a separate axis from all of these.** This toolkit sets
  up a host and writes `FICUS_SANDBOX_RUNTIME` from `runtime.sandbox`; which of
  `host`, `docker-socket`, `docker-sysbox`, `vm`, or `k8s` you pick is chosen in
  [`docs/wiki/sandbox-runtimes.md`](../../docs/wiki/sandbox-runtimes.md). The toolkit
  seeds the `vm` runtime's exe.dev credential (`runtime.exe.*`) and installs
  Docker when the database runs in a container, but it does not build a
  Kubernetes cluster — `sandbox: k8s` expects one to exist. `docs/wiki/hosting.md`
  maps both axes.
- `ecosystem.config.example.js` (pm2) — superseded by the systemd units for
  hosts set up with this toolkit; still used for local dev.

## API memory guardrail

Tenant hosts constrain the api unit (`ficus-api`) with a host-relative cgroup budget: soft
reclaim begins at 25% of host RAM and `MemoryMax=35%` is the hard cap. This
leaves 65% for the OS, machine agent, worker, database/runtime, and sandboxes
across the supported roughly 2–16 GiB host range. A cgroup OOM kills the whole
API process tree and is journaled; `Restart=on-failure` retries after five
seconds, bounded to five starts per five minutes. A repeated wedge therefore
fails closed instead of causing an unbounded restart storm. After repair:

```bash
sudo systemctl reset-failed ficus-api
sudo systemctl start ficus-api
```

Inspect the current budget, OOM result, and restart count with:

```bash
systemctl show ficus-api -p Result -p NRestarts -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax
journalctl -u ficus-api -b --no-pager
```

This guardrail is pilot host insurance, not the memory-leak fix. If fleet-wide
aggregation becomes necessary, a separate change should add one low-cardinality
api unit `NRestarts` delta to the machine usage payload; no API restart-count
payload seam exists today, so this pilot uses systemd and journald.

On a disposable Ubuntu 24.04 systemd host only, the opt-in proof renders a
unique runtime unit, triggers a test-only 64 MiB cgroup OOM, verifies the
replacement serves HTTP, and removes all runtime state:

```bash
sudo FICUS_API_MEMORY_E2E=1 bash scripts/setup/api-memory-guardrail-e2e.sh
```

Never run the memory test on a tenant host.
