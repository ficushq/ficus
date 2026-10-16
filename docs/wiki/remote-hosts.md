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
   fetches the host's own SSH host keys (see step 3), materializes the
   squad's SSH directory, and prints the **public** key plus install
   instructions. Use `--global` to register without granting any squad yet
   (needs global `remote-hosts:write`); grant squads later with `grant`.

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

3. **Confirm the host key** (a person, always). When a host is added, Core
   fetches its public host keys without logging in (`ssh-keyscan`, 5s
   connect timeout, 15s overall) and stores them as **pending**. Until a
   person trusts one, the host is unusable: its stanza refuses every
   connection with
   `ficus: remote host <name> is blocked until a person confirms its SSH host key ...`.

   ```bash
   ficus remote-hosts host-keys staging          # state, each key's type + SHA256 fingerprint
   ficus remote-hosts trust-key staging SHA256:… # or reject-key
   ficus remote-hosts fetch-key staging          # fetch again (e.g. the host was unreachable)
   ```

   The same screen is in the web UI (squad settings and admin settings →
   Remote Hosts) with Trust / Reject per key. Compare the fingerprint with
   one obtained from the host itself (for example
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Trusting and
   rejecting are **person-only**: the API refuses agents, system tokens and
   the ownerless bootstrap session on every path, whatever their
   permissions, and records who decided and when. See § Host Key
   Verification.

4. **Verify connectivity**:

   ```bash
   ficus remote-hosts check staging
   ```

   Runs a server-side `ssh` probe using the minted key and reports
   `{ reachable, error? }`. The probe checks the host key strictly against
   the trusted keys only; a host without one is reported unreachable with
   "The host key has not been confirmed yet". Squad managers can check any host granted to
   their own squad without needing global write
   (`POST /api/remote-hosts/squad/:squadId/check/:hostId`); global write can
   check via the registry surface directly (`--all`).

5. **Grant additional squads** (global write only):

   ```bash
   ficus remote-hosts grant staging --squad <other-squad-id>
   ```

6. **Agent usage.** Every agent in a granted squad gets an SSH config entry
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

   Every connection checks the host key strictly against the confirmed
   key (`StrictHostKeyChecking yes`, `UpdateHostKeys no`); nothing is ever
   accepted on first use or updated automatically.

## Host Key Verification

`apps/core/src/services/remote-hosts/host-keys.ts`. Each key a host
presents is a `remote_host_keys` row: type, SHA256 fingerprint, status
(`pending` / `trusted` / `rejected` / `replaced`), origin (`scan` /
`adopted` / `adoption-conflict`), and the audit fields
`decided_by_user_id` / `decided_at` / `decision_note`. A host's state:

| State        | Meaning                                                                                     | Agents                                                   |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `trusted`    | A key is pinned.                                                                            | Connect, strictly checked.                               |
| `changed`    | The host presented a different key of a pinned type.                                        | Refused (strict check) until a person trusts or rejects. |
| `pending`    | Fetched keys wait for a person (new host, or conflicting adoption evidence).                | Blocked: the stanza refuses with a message.              |
| `unverified` | No key to confirm: the fetch failed (`hostKeyCheckError`) or every key was rejected.        | Blocked.                                                 |
| `adopting`   | Registered before keys were pinned; existing trust is being adopted (see § Existing hosts). | Connect, strictly checked against what the box trusts.   |

- **Pinning.** Trusted keys are written into the squad's Core-managed
  `known_hosts` (inside the `# >>> ficus managed known hosts >>>` block,
  which then reaches boxes as described under § Security Model) under a
  per-host alias, `ficus-remote.<name>`, and the stanza names it with
  `HostKeyAlias`. Only Core-managed entries therefore count: a key a box
  learned for the real hostname (for example through the old `accept-new`)
  never satisfies the check. `ficus-remote.*` is Core's namespace: the
  squad known_hosts API refuses entries naming it, and materialization drops
  any line outside the block that would match a pinned alias (plain, hashed
  or wildcard), so no second key can be added for an alias.
- **Key change.** A later fetch that sees a different key of a pinned type
  records it as pending; the host shows `changed` with the old and new
  fingerprints. Nothing auto-updates: connections keep being refused until
  a person trusts the new key (the old one becomes `replaced`) or rejects
  it. A key of a new type is recorded as pending without blocking the host.
- **Rejected keys stay rejected** across later fetches.
- **Propagation.** A decision re-materializes every granted squad's SSH
  directory at once, which docker, k8s and host-runtime sandboxes see
  directly. A long-lived vm box picks it up on its next ensure, or right
  away with `ficus remote-hosts sync` from the box; until then it keeps the
  previous (strict) state, so a delay can only refuse a connection, never
  allow one.
- **Agents can fetch, never decide.** `fetch-key` (scan) only records
  pending keys, so it needs ordinary `remote-hosts:write`. A host granted
  to more than one squad can only be decided from the squad surface by
  someone who also holds global `remote-hosts:write`, so one squad cannot
  pin a key for another squad's host.

### Existing hosts

The migration marks every host registered before this change as
`adopting`. At worker boot Core adopts the keys already trusted for each
one, recorded as trusted with origin `adopted`, no `decided_by_user_id`,
and the note `adopted from existing trust (<where>)` — no prompt, no user
action. Evidence is read at runtime through Core's own access: Core's
connectivity-check `known_hosts`, each granted squad's Core SSH directory
`known_hosts` (docker mounts it as the box's `~/.ssh`; the host runtime
points ssh at it), and `~/.ssh/known_hosts` of each ready vm box of a
granted squad. Only plain or hashed entries for the exact
`host`/`[host]:port` name count.

- One key per type across all evidence: adopted.
- Different keys of the same type anywhere: nothing is picked. Every
  candidate becomes pending (origin `adoption-conflict`, note listing where
  each was seen) and the host waits for a person.
- No key anywhere and every source was read: fetched and held for
  confirmation, like a new host.
- No key found but a box could not be read: stays `adopting` and is retried
  at the next boot (or when someone runs `fetch-key`). Meanwhile its stanza
  uses strict checking against the keys each box already trusts — never
  trust-on-first-use.

(k8s pods mirrored `known_hosts` with `rsync --delete` before the managed block existed, so
they hold no learned keys to adopt.)

## Box known_hosts conflicts

When a vm box's own `~/.ssh/known_hosts` pins a different key than a
Core-managed entry for the same host and key type, the managed entry is
left out of that box (§ Security Model). Core records each box's current
conflicts after every merge (`known_hosts_conflicts`:
squad, box, host, key type, both fingerprints, box line, wildcard flag,
detected / last-seen times) and clears the ones that are gone. A box line
that names the host through a wildcard (`*`, `?`; negations honoured) is a
conflict too. Different key types are not conflicts.

They are listed on the squad's Remote Hosts settings and by
`ficus remote-hosts conflicts` (agents can read them, so one hitting
"Host key verification failed" can see a person must decide). A person
(never an agent; needs the squad's `ssh:write`) resolves each:

- **Keep box key**: the box key stays and that exact pair of fingerprints
  is no longer reported. A different box or Core key is a new conflict.
- **Use Ficus key** (`--use-core`): removes the host's trust from the
  conflicting box line(s) of that key type — plain and hashed; a
  comma-separated line keeps its other hosts — and writes the managed
  entry, through the same compare-and-swap `0600` write as every sync.
  Every other line is kept byte-for-byte. **A wildcard line is never
  edited** (it may cover hosts Ficus knows nothing about, and adding a
  negation would silently narrow it): the action is refused and the line
  must be edited by hand on the box, or the box key kept.

Conflicts refresh whenever the box's squad SSH material is pushed (box
ensure, or `ficus remote-hosts sync` from the box). Merges the k8s
entrypoint runs inside a pod are logged there and not yet recorded.

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
    keys `0600`, `config` `0644`, the `.ssh` dir `0700` — the same push
    path as every other box-provisioned file. This also closed a
    pre-existing parity gap: squad SSH keys previously never reached VM
    boxes at all. `known_hosts` is the exception: the box's own file also
    holds host keys trusted on the box, so the squad's entries are merged
    into a delimited `# >>> ficus managed known hosts >>>` block
    (`packages/shared/src/known-hosts.ts`) by an atomic compare-and-swap
    write (`0600`), never pushed over the file. Lines outside the block are
    kept; a managed entry whose host already has a different key of the
    same type on the box is reported as a conflict and not written. The
    k8s entrypoint mirrors the squad SSH directory into `/root/.ssh` the
    same way (`packages/sandbox-server/src/known-hosts-sync.ts`).
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
- **Host keys are confirmed by a person** and pinned; see § Host Key
  Verification.
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
    HostKeyAlias ficus-remote.staging
    StrictHostKeyChecking yes
    UpdateHostKeys no
  Host blocked-host
    HostName 10.1.2.4
    Port 22
    User deploy
    StrictHostKeyChecking yes
    ProxyCommand sh -c 'echo "ficus: remote host blocked-host is blocked until a person confirms its SSH host key (...)" >&2; exit 1'
  # <<< ficus remote hosts <<<
  ```

  A host without a trusted key gets the refusing stanza and no key file; a
  host still adopting existing trust gets the first form without
  `HostKeyAlias`. On the host runtime each usable stanza also pins
  `UserKnownHostsFile <squad ssh dir>/known_hosts`.

- The trusted keys, in the squad's `known_hosts` managed block:
  `ficus-remote.staging ssh-ed25519 AAAA…`.

`materializeSquadRemoteHosts(squadId)` is **idempotent and complete**: every
call rewrites the managed block from current DB state and deletes any
`ficus_remote_*` key file for a host no longer granted. It runs on every
mutation that can affect a squad's grants or host keys — host
create+grant, grant, revoke, host delete, host-key fetch, trust, reject and
adoption. `setKnownHosts`/`addKnownHost` keep the pinned keys the same way
`setSshConfig` keeps the managed config block.

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
| `ficus remote-hosts host-keys <name> [--all] [--squad <id>]`                                                         | squad / global                                      | `remote-hosts:read`  | Host-key state and each key's fingerprint and decision.                                                                        |
| `ficus remote-hosts fetch-key <name> [--all] [--squad <id>]`                                                         | squad / global                                      | `remote-hosts:write` | `ssh-keyscan` (no login); new keys are pending.                                                                                |
| `ficus remote-hosts trust-key\|reject-key <name> <fingerprint> [--all] [--squad <id>]`                               | squad / global                                      | `remote-hosts:write` | **People only**; agents are refused. Shared hosts need global write.                                                           |
| `ficus remote-hosts conflicts [--squad <id>]`                                                                        | squad                                               | `remote-hosts:read`  | Box known_hosts conflicts.                                                                                                     |
| `ficus remote-hosts resolve-conflict <id> --keep-box\|--use-core [--squad <id>]`                                     | squad                                               | `ssh:write`          | **People only**; `--use-core` is refused for a wildcard line.                                                                  |
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
  revoke. Gated on `can('remote-hosts:write')` for the squad. Each row shows
  its host-key state; a blocked or changed host opens the host-key panel
  (`apps/web/src/components/settings/HostKeysPanel.tsx`: type + SHA256
  fingerprint per key, confirm-gated Trust / Reject, Fetch host key), and
  open box known_hosts conflicts are listed below the hosts with Keep box
  key / Use Ficus key (needs `ssh:write`; Use Ficus key is not offered for
  a wildcard line).
- **Admin settings** — `apps/web/src/components/settings/RemoteHostsSection.tsx`,
  next to the Machines admin section: the full registry, an add form,
  expandable row detail with the public key block, per-host grants
  management (squad chips, add/remove), and check/delete row actions. Gated
  on `can('remote-hosts:read'/'write')` globally. The same host-key panel
  shows under any host that needs a decision, and in the expanded detail.

## Related

- Agent-facing skill: `config/skills/remote-hosts/SKILL.md` (granted to
  `manager` and `system-manager` agent types).
- Design doc: `docs/history/superpowers/specs/2026-07-14-remote-hosts-design.md`.
- Contrast: `docs/wiki/machines/runtime.md` (`machines` = substrate ficus
  bootstraps; remote hosts = targets ficus never touches).
