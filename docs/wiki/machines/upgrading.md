# Upgrading existing installs across the machine-stack merge

The VM-machines stack (PRs #608–#634, #618/#620/#630, merged 2026-07-24)
changed per-sandbox asset delivery on every runtime and added the VM runtime.
What an existing install must do, by runtime:

## Database (all runtimes)

All migrations are additive for pre-stack installs (the `machines` /
`machine_boxes` tables, `agents`/`squads.machine_id`, `synced_hashes` are new
columns/tables). Run `FICUS_MIGRATE_LIVE=1 bun run db:migrate` on deploy — the
flag explicitly confirms the configured live database; no other manual steps
are needed and nothing is destructive. (Migration 0076 drops `server_bundle_version`, a column
introduced _within_ this stack — installs upgrading from before the stack
never had it.)

## k8s — no manual action

The pod spec changed:

- Squad-**member** pods no longer mount `/memory/<squadId>` (memory is
  squad-box-only everywhere; agents access memory via the core-side `memory_*`
  tools, so nothing user-visible changes).
- Per-asset subPath mounts (skills/memory/ssh) now derive from the shared
  asset manifest.

Existing pods self-heal through spec-drift recreation on their next
ensure/warmup. Expect a one-time pod recreation wave after deploy.

## docker — automatic since the machines-backlog wave

The docker runtime now has **volume-drift detection**. Each `tau-sandbox-*`
container is stamped at create with a `tau.spec-hash` label derived from its
mount-affecting spec (image, runtime, workspace/private binds, squad, and the
`-v` volume list). On the next `ensure`, a container whose label differs from
the current spec — or whose label is missing (a container created before this
wave) — is removed and recreated with the new mount set (single read-only parent
skills mount, manifest-driven binds). No manual step is needed: mount-changing
upgrades take effect lazily on next use.

Historical note (pre-this-wave versions had no drift detection): the manual
sweep below force-removed stale sandbox containers so they would recreate with
the new mounts. It is no longer required but remains safe to run.

```bash
docker ps -a --format '{{.Names}}' | grep '^tau-sandbox-' | xargs -r docker rm -f
```

Nix stores: new sandboxes clone from the shared `~/.tau/nix/.base` (seeded
once from the image; hardlink/CoW per sandbox). Existing full-copy per-sandbox
stores stay as-is and are reclaimed by the terminal-lifecycle cleanup (#632)
as their agents are deleted.

## host — nothing to do

The `host` runtime has no containers, pods, or boxes to recreate: agents run in
the core's own storage directories, so a deploy takes effect on the next agent
turn. See `docs/wiki/host-runtime.md`.

## Renamed runtime values (all installs)

`FICUS_SANDBOX_RUNTIME` is now required and takes exactly `docker-sysbox`,
`docker-socket`, `k8s`, `vm`, or `host`. The old spellings were removed, not
aliased — an install still carrying one fails to start with an error naming the
replacement:

| Old value | Now                                                  |
| --------- | ---------------------------------------------------- |
| `sysbox`  | `docker-sysbox`                                      |
| `socket`  | `docker-socket`                                      |
| `auto`    | choose `docker-sysbox` or `docker-socket` explicitly |
| `docker`  | choose `docker-sysbox` or `docker-socket` explicitly |

Setup-toolkit installs carry the same value as `runtime.sandbox` in the config
yaml. See `docs/wiki/sandbox-runtimes.md`.

**Edit `.env` BEFORE restarting.** An upgrade rewrites no `.env` — whatever
`FICUS_SANDBOX_RUNTIME` an install carries today (`auto`, `docker`, `sysbox`,
`socket`, or nothing at all) is still there after the new code is deployed, and
the api and worker refuse to start on it. The setup toolkit's
`upgrade-host.sh` and the in-app updater stop before the restart rather than
leave the instance down, so the upgrade fails until the value is fixed. The
in-app preflight ships WITH this change, so an instance still running
pre-rename code must set `FICUS_SANDBOX_RUNTIME` in `.env` BEFORE applying the
update that introduces it; `upgrade-host.sh` from this checkout is safe either
way.

**Expect one fleet-wide docker recreate.** The selected runtime is part of a
sandbox container's spec hash, and the rename changes it (`socket` →
`docker-socket`, `sysbox` → `docker-sysbox`), so every existing
`tau-sandbox-*` container drifts and is recreated once on its next ensure.
This is safe and needs no action: workspaces, memory and private dirs are bind
mounts on the host, and the old per-sandbox nix stores are reclaimed host-side
by the terminal-lifecycle cleanup. Only the first ensure after the upgrade pays
for it.

## vm runtime — opt-in only

`FICUS_SANDBOX_RUNTIME=vm` enables the new runtime; existing k8s/docker installs
are unaffected without it. All new env vars (`FICUS_MACHINE_REVERSE_PORT`,
`FICUS_UNIT_WEIGHT_*`, `FICUS_MACHINE_UNIT_CAPACITY`, `FICUS_MAX_MACHINES`, …) are
optional with defaults. The prebaked machine image
`ghcr.io/ficushq/ficus-machine` is public (no pull auth needed).

See `docs/backlog/machines/follow-ups.md` for the remaining post-merge backlog and
user-gated items.
