# Remote Hosts

Remote hosts let a squad reach a team-owned box over SSH — a staging server,
a build machine, a Mac with Xcode, a Windows box with `sshd` — **without**
ficus installing anything on it. This is deliberately the opposite of
`machines` (`docs/wiki/machines/runtime.md`): a machine is substrate ficus
bootstraps and runs agent sandboxes on; a remote host is a target ficus's
agents merely SSH _into_. See § Motivation of
`docs/history/superpowers/specs/2026-07-14-remote-hosts-design.md` for the full
rationale and the agent-facing `config/skills/remote-hosts/SKILL.md` for the
in-agent usage guide this document backs.

## Walkthrough

1. **Register the host** (operator or squad manager, from a squad agent box
   or via the CLI directly):

   ```bash
   ficus remote-hosts add --name staging --host 10.1.2.3 --user deploy
   ```

   This mints a fresh ficus-owned ed25519 keypair, inserts a `remote_hosts`
   row, grants the calling squad (`FICUS_SQUAD_ID`, or `--squad <id>`) access,
   materializes the squad's SSH directory, and prints the **public** key
   plus install instructions. Use `--global` to register without granting
   any squad yet (needs global `remote-hosts:write`); grant squads later
   with `grant`.

2. **Install the public key on the target** (human step, always). The
   printed block looks like:

   ```
   ssh-ed25519 AAAA... ficus-remote-host-<id>
   Ask the owner of 10.1.2.3 to append the line above to ~/.ssh/authorized_keys for user deploy.
   Then verify with: ficus remote-hosts check staging.
   ```

   ficus never asks for or accepts an uploaded private key for a remote host
   — it only ever mints its own and shows the public half. There is no way
   to skip this step; the host is unusable until a human with access to it
   appends the key.

3. **Verify connectivity**:

   ```bash
   ficus remote-hosts check staging
   ```

   Runs a server-side `ssh` probe using the minted key and reports
   `{ reachable, error? }`. Squad managers can check any host granted to
   their own squad without needing global write
   (`POST /api/remote-hosts/squad/:squadId/check/:hostId`); global write can
   check via the registry surface directly (`--all`).

4. **Grant additional squads** (global write only):

   ```bash
   ficus remote-hosts grant staging --squad <other-squad-id>
   ```

5. **Agent usage.** Every agent in a granted squad gets an SSH config entry
   and private key automatically — Docker/k8s sandboxes see it the moment
   it's materialized (their `~/.ssh` is a live mount of the squad's SSH
   dir); a long-lived VM box that predates the grant needs one manual
   refresh:

   ```bash
   ficus remote-hosts sync
   ```

   On the `host` runtime there is no `~/.ssh` mount at all: agents get
   `GIT_SSH_COMMAND` pointed at the squad's SSH config (and `known_hosts`),
   and `ssh`/`scp`/`rsync` on the agent PATH are ficus shims that use the same
   config whenever every remote destination is a ficus-managed alias and no
   explicit `-F`/`-e`/`--rsh` was passed — so the plain commands below reach
   granted hosts too. Anything naming an operator destination runs untouched
   against the operator's own ssh. Ficus re-materializes the SSH config of
   every granted squad once at worker boot (idempotently), so grants made
   before a host-mode switch come current without waiting for another grant
   mutation. The one remaining limitation: only aliases inside ficus's managed
   block are shimmed — a user-added alias in the squad config's user section
   still needs `ssh -F "$FICUS_SQUAD_SSH_DIR/config" <alias>`. See
   [host-runtime.md](host-runtime.md).

   After that, it's plain SSH tooling, no wrapper:

   ```bash
   ssh staging
   scp file.tar.gz staging:/srv/releases/
   rsync -av ./dist/ staging:/srv/app/
   ```

   The first connection auto-accepts the host key
   (`StrictHostKeyChecking accept-new`).

## Security Model

- **Key minting, not upload.** Every remote host gets its own ficus-minted
  ed25519 keypair (`generateRemoteHostKeypair`, sharing the mint/store
  mechanism `apps/core/src/services/machines/keys.ts` uses for machines).
  ficus never accepts a user-supplied private key for a remote host.
- **Custody.** The private key lives in the secret store at rest, under
  `remote-host-ssh:<hostId>`. Deleting a host deletes its secret —
  revoking one host revokes exactly one credential; no shared blast
  radius across hosts.
- **Transit.** The private key **never appears in any API response, CLI
  output, or web payload** — only the public key does. It moves core→box
  over the same trusted paths already used for `identity.pem` and squad SSH
  keys:
  - **docker/k8s**: no transit at all — the squad's SSH directory is
    live-mounted at `/home/ficus/.ssh` inside every running sandbox
    (`apps/core/src/services/sandbox/ensure.ts`), so a materialized change
    is visible immediately.
  - **VM boxes**: pushed over the box server's `/write` channel by
    `syncBoxFiles` (`apps/core/src/services/sandbox/vm/file-sync.ts`) —
    keys `0600`, `config`/`known_hosts` `0644`, the `.ssh` dir `0700` —
    the same push path as every other box-provisioned file. This also
    closed a pre-existing parity gap: squad SSH keys previously never
    reached VM boxes at all.
  - **host runtime**: no transit and no mount — agent commands run on the
    core's own machine, and the squad's SSH directory is referenced in place
    through `GIT_SSH_COMMAND` and the PATH-level `ssh`/`scp`/`rsync` shims
    (see [host-runtime.md](host-runtime.md)). The shims only ever ADD the
    squad config (`-F`) and pinned `known_hosts` — never weakening host-key
    checking — and pass through any command whose destination is not a
    ficus-managed alias.
- **Grant semantics are squad-wide by design.** A grant gives _every_ agent
  in that squad SSH access to the host — there is no per-agent grant.
  Revoking a squad's grant removes its key file from that squad's SSH
  directory immediately (next materialization).
- **Revoke rotates the host key.** Revoking a grant removes the key from
  core-side distribution AND rotates the host's minted keypair, so a private
  key the revoked squad copied stops working once you install the new public
  key. The rotated public key is returned to the caller (CLI/web) — append it
  to `~/.ssh/authorized_keys` on the host and remove the old line; the remaining
  granted squads can only reconnect after you do. (A VM box that already pulled
  the previous key keeps it until its next `ensure`/`sync`, which re-materializes
  and re-pushes the rotated key.)
- **Every revoke rotates, including a no-op re-revoke.** Rotation is
  unconditional — re-revoking an already-revoked grant (the retry path after a
  rotation failure) rotates again, and each rotation invalidates the previous
  public key. So **every** revoke, even a repeated one, requires installing the
  freshly returned public key in `authorized_keys` before the granted squads can
  reconnect.
- **Input validation** guards against ssh_config directive injection:
  `name` is restricted to `^[a-z0-9][a-z0-9-]{0,62}$` (it doubles as the SSH
  alias agents type), and `sshHost`/`sshUser` must be non-empty with no
  whitespace/newlines — both enforced at the route layer and re-checked
  independently by the materializer immediately before interpolation into
  `ssh_config`.

## The Managed-Block Contract

Materialization writes into each granted squad's SSH directory
(`apps/core/src/services/squad/ssh.ts`, `apps/core/src/services/remote-hosts/materialize.ts`):

- One `ficus_remote_<name>` private key file (mode `0600`) per granted host.
- A block in `config` delimited by markers:

  ```
  # >>> ficus remote hosts >>>
  Host staging
    HostName 10.1.2.3
    Port 22
    User deploy
    IdentityFile ~/.ssh/ficus_remote_staging
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
  # <<< ficus remote hosts <<<
  ```

`materializeSquadRemoteHosts(squadId)` is **idempotent and complete**: every
call rewrites the managed block from current DB state and deletes any
`ficus_remote_*` key file for a host no longer granted. It runs on every
mutation that can affect a squad's grants — host create+grant, grant,
revoke, host delete.

`setSshConfig` — the pre-existing path a squad manager uses to hand-edit
their squad's SSH config — is taught to preserve the managed block in both
directions: it strips any managed block from the incoming content (so a
caller can't forge one), writes the user's content, then re-appends the
_current_ managed block computed from the DB. User edits can never clobber
ficus-managed entries, and ficus's writes can never clobber user content outside
the markers.

## CLI Reference

| Command                                                                                                              | Surface                                             | Permission           | Notes                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ficus remote-hosts list [--all] [--squad <id>]`                                                                     | squad (default) / global (`--all`)                  | `remote-hosts:read`  | Squad defaults to `FICUS_SQUAD_ID`.                                                                                            |
| `ficus remote-hosts show <name> [--all] [--squad <id>]`                                                              | squad / global                                      | `remote-hosts:read`  | Re-prints install instructions.                                                                                                |
| `ficus remote-hosts add --name <n> --host <h> --user <u> [--port <p>] [--description <d>] [--squad <id>] [--global]` | squad add-and-grant (default) / global (`--global`) | `remote-hosts:write` | Prints the public key + install block.                                                                                         |
| `ficus remote-hosts grant <name> --squad <id>`                                                                       | global                                              | `remote-hosts:write` | Grant a squad access to an existing host.                                                                                      |
| `ficus remote-hosts revoke <name> [--squad <id>]`                                                                    | squad (default, own squad) / global (`--squad`)     | `remote-hosts:write` | Never deletes the host.                                                                                                        |
| `ficus remote-hosts remove <name>`                                                                                   | global                                              | `remote-hosts:write` | Deletes the host + its secret entirely.                                                                                        |
| `ficus remote-hosts check <name> [--all] [--squad <id>]`                                                             | squad (default) / global (`--all`)                  | `remote-hosts:write` | Server-side `ssh` reachability probe.                                                                                          |
| `ficus remote-hosts sync`                                                                                            | squad (own squad only)                              | `remote-hosts:read`  | Re-pushes SSH artifacts to the calling agent's VM box; no-op hint (`live-mount`) on docker/k8s, and on host (nothing to push). |

Underlying routes: `apps/core/src/routes/remote-hosts.ts`, mounted at
`/api/remote-hosts` (global surface) and `/api/remote-hosts/squad/:squadId`
(squad surface). CLI implementation:
`apps/cli/src/commands/remote-hosts.ts` (`registerRemoteHostsCommands`).

## Web UI

- **Squad settings** — `apps/web/src/components/squads/RemoteHostsSettings.tsx`:
  a card-row list of hosts granted to the squad (name, `user@host:port`,
  granted-at), an inline add-form (add-and-grant, shows the pubkey +
  install instructions immediately), per-row copy-pubkey, and a confirm-gated
  revoke. Gated on `can('remote-hosts:write')` for the squad.
- **Admin settings** — `apps/web/src/components/settings/RemoteHostsSection.tsx`,
  next to the Machines admin section: the full registry, an add form,
  expandable row detail with the public key block, per-host grants
  management (squad chips, add/remove), and check/delete row actions. Gated
  on `can('remote-hosts:read'/'write')` globally.

## Related

- Agent-facing skill: `config/skills/remote-hosts/SKILL.md` (granted to
  `manager` and `system-manager` agent types).
- Design doc: `docs/history/superpowers/specs/2026-07-14-remote-hosts-design.md`.
- Contrast: `docs/wiki/machines/runtime.md` (`machines` = substrate ficus
  bootstraps; remote hosts = targets ficus never touches).
