---
name: remote-hosts
description: 'Register and manage team-owned SSH targets (staging servers, build machines, a Mac with Xcode, a Windows box with sshd) so a squad can reach them. Requires the remote-hosts:write permission scope. Use when a squad needs to SSH into an existing box the team already runs.'
required-permission: remote-hosts:write
---

# Remote Hosts

## When to Use

Use this skill when the team already runs a box — a staging server, a build
machine, a Mac with Xcode, a Windows box with `sshd` — and a squad needs to
reach it over SSH: deploy to it, run a build on it, copy files to/from it,
inspect logs on it.

**Remote hosts are not machines.** A `machines` row is substrate tau
_colonizes_: tau bootstraps it, creates a Unix user on it, installs a sandbox
server, and runs agent sandboxes on it. A remote host is the opposite — it's
a target the team already owns and operates. tau never installs anything on
it, never creates users on it, and never runs sandboxes on it. Agents just
adapt to whatever the host already has (any OS with an `sshd`). If the goal
is "give tau a new place to run agent sandboxes," that's the `machines`
feature, not this one.

## Adding a Host

```bash
tau remote-hosts add --name staging --host 10.1.2.3 --user deploy
```

This mints a fresh ed25519 keypair for this host, registers it, grants your
squad (`FICUS_SQUAD_ID`) access, and prints:

1. The **public key** (one line, ready to paste).
2. Install instructions for the human who owns the box.

The private key never leaves tau's secret store and is never printed,
returned by the API, or shown in the web UI — only the public key is ever
surfaced. That means installation **requires a human**: hand the printed
block to the box's owner (in chat, a ticket, however you'd reach them) and
wait for them to confirm they've appended it to
`~/.ssh/authorized_keys` for the given user. Do not proceed as if the host is
usable until they confirm — the key genuinely is not installed until a human
installs it.

Once they confirm, verify:

```bash
tau remote-hosts check staging
```

`"staging" is reachable.` means the connection works end-to-end. Only then
tell the squad the host is ready — e.g. "staging is set up, `ssh staging`
works."

Other useful flags on `add`:

- `--port <p>` — non-default SSH port (default `22`).
- `--description <d>` — free-text note shown in `list`/`show`.
- `--squad <id>` — grant a different squad instead of your own (needs write
  on that squad).
- `--global` — register without granting any squad (needs global
  `remote-hosts:write`); grant it to squads later with `grant`.

## Using Hosts (what to tell squad members)

Once a host is granted to a squad, every agent in that squad gets an SSH
config entry and private key automatically — nothing to install per agent.
Docker/k8s sandboxes see it live (the squad's `~/.ssh` is mounted); a
long-lived VM box may need one manual refresh if it predates the grant:

```bash
tau remote-hosts sync
```

`sync` only refreshes the **calling agent's own box** — it has no notion of
"the squad's boxes" collectively. In a multi-box squad, each agent runs it
for itself; one agent syncing does not refresh a teammate's box. (Fresh boxes
and Docker/k8s sandboxes don't need this at all — see above.)

After that, agents use completely normal SSH tooling — no tau-specific
wrapper:

```bash
ssh staging
scp file.tar.gz staging:/srv/releases/
rsync -av ./dist/ staging:/srv/app/
```

The first connection to a given host auto-accepts its host key
(`StrictHostKeyChecking accept-new` in the managed config) — no manual
`known_hosts` prompt to answer.

## Adapt to the Target

A remote host is the **team's** box, not tau's. Before doing anything on it:

- Discover what's actually there — `uname -a`, `which <tool>`, check for a
  package manager, look at what's already deployed — rather than assuming a
  particular OS or toolchain.
- Use what's installed. Work with the host's existing shell, package
  manager, and layout.
- **Never install tau tooling on it** (no sandbox server, no tau CLI, no
  background agents) and never make invasive changes (reformatting,
  package upgrades, service restarts affecting other consumers) without the
  owner's explicit ask. Treat it like someone else's production machine,
  because it is.

## Managing

- `tau remote-hosts list` / `show <name>` — squad surface by default
  (`remote-hosts:read`, squad-scoped); `--all` for the whole registry
  (needs global `remote-hosts:read`).
- `tau remote-hosts add` — squad managers can add-and-grant for their own
  squad (squad-scoped `remote-hosts:write`); `--global` needs global write.
- `tau remote-hosts grant <name> --squad <id>` — grant another squad access.
  **Global write only** — system managers, not squad managers.
- `tau remote-hosts revoke <name>` — revoke your own squad's grant
  (squad-scoped write); `--squad <id>` revokes a different squad's grant
  (needs global write).
- `tau remote-hosts remove <name>` — delete the host entirely (registry row
  - secret key), revoking it for every squad. **Global write only.**

## Troubleshooting

- **`check` fails / "NOT reachable"**: usually one of —
  - the public key hasn't been installed on the target yet (the most common
    cause right after `add` — confirm with the box owner);
  - the host is unreachable (network/firewall, wrong `--host`, box is down);
  - the wrong SSH user was registered (`--user` doesn't have an account, or
    the account exists but the key wasn't installed for it).
- **`ssh <name>` says "Permission denied (publickey)"**: same causes as
  above — the key isn't installed yet, or the box's `~/.ssh` material is
  stale on this agent's box; run `tau remote-hosts sync` and retry.
- **`sync` reports `live-mount`**: nothing to do — this box mounts the
  squad's SSH directory live, so the new grant is already visible.
- **`sync` reports `box-unreachable`**: the box isn't reachable right now;
  try again once it wakes.

## Reference

- API: `/api/remote-hosts` (global registry surface) and
  `/api/remote-hosts/squad/:squadId` (squad surface) —
  `apps/core/src/routes/remote-hosts.ts`.
- CLI: `apps/cli/src/commands/remote-hosts.ts`
  (`registerRemoteHostsCommands`).
- Materialized into the squad's SSH directory as one `ficus_remote_<name>`
  private key file (mode `0600`) plus a managed block in `config` delimited
  by `# >>> ficus remote hosts >>>` / `# <<< ficus remote hosts <<<`
  (`apps/core/src/services/remote-hosts/materialize.ts`). User-added config
  outside the managed block is always preserved.
- Full walkthrough + security model: `docs/wiki/remote-hosts.md`.
