# Managed shared BigBrain vaults (Ficus Cloud)

> Containment verified on a disposable Linux runner (two vaults, attacks from inside a vault,
> disk exhaustion, backup staging, revoke, suspend/resume and delete). Not yet released.

On Ficus Cloud, a team can run several [BigBrain](https://bigbrain.cool) vaults **on its own
Ficus server**. People read and write a vault from the BigBrain app. Squads you choose can
**read** it through five read-only agent tools. Ficus agents never write to a shared vault, and
Ficus never imports conversations into one.

This is separate from the personal [local BigBrain connector](bigbrain.md) on Desktop and
self-hosted Core. On Ficus Cloud the BigBrain integration shows **shared vaults**. The local
connector, including its `bigbrain_drop` tool, is unavailable there.

## What runs where

Every vault is its own BigBrain server process on the tenant's existing Ficus server. No extra
servers are created.

| Per vault   | Shape                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| Identity    | A dedicated, unprivileged system account with no login                                 |
| Storage     | Its own fixed-size ext4 image (512 MiB), mounted `nodev,nosuid,noexec`                 |
| Process     | Its own systemd service: 256 MiB memory, 64 tasks, private `/tmp` (16 MiB), no devices |
| Network     | No IP sockets at all. It listens only on its own Unix socket                           |
| Namespaces  | Private network and IPC namespaces; it cannot create new namespaces                    |
| Syscalls    | Native architecture only; privileged and resource-control system calls are refused     |
| Credentials | Its own owner, members and one read-only Ficus credential                              |

All vaults together are capped at 640 MiB of memory and 50% of one CPU. A server hosts at most
two vaults. Ficus keeps at least 2 GiB free for itself before it creates another vault.

## Who decides

**Ficus Core on the tenant's server is the authority for its vaults.** Core records every
create, rename, retry, read revoke or reconnect, owner device link and delete in its own
database, and runs each one on the same server through a local root helper
(`/usr/local/libexec/ficus-bigbrainctl`). No other service keeps a list of the vaults.

Ficus Cloud's Platform does only these things for managed BigBrain:

- install the feature on a server when it is enabled for the tenant;
- report whether the server is installed and active, and its vault zone;
- create and remove the exact DNS record for each vault host name, tagged with the tenant and
  vault. It never deletes by wildcard;
- run tenant lifecycle: suspend, resume, termination backup and restore.

Platform keeps no vault names, generations, tombstones or credentials.

## Trust boundary

**Ficus's own server software is trusted with every shared vault on that server.** Hosted Ficus
Core runs as `root` and reads each vault's private Ficus read handoff directly. Anyone who
compromises Ficus Core on a tenant's server can therefore read, change or delete every managed
vault on that server, and the members' data in them. The isolation below protects vaults from
each other and the host from a vault. It does not protect vaults from Ficus Core.

What is enforced:

- One vault cannot read, write or reach another vault, the gateway or the host's control state.
- The gateway holds no credentials and only routes by host name.
- Ficus's read credential is an upstream agent with exactly `read` that follows no member.
- Agents get five read tools that each name one vault. Shared tools are offered only to agents
  on an isolated sandbox runtime, never to `host`-runtime agents, whose shells run as the Core
  account.
- The owner's device-link escrow never leaves the root control worker: no Core API, Platform
  response or log carries it. The single-use device link is returned only to its owner.

Requests reach a vault only through a small gateway. Caddy terminates TLS for
`https://bb-<vault>.<zone>` and forwards to the gateway's Unix socket. The gateway selects the vault
by host name and holds no credentials. A vault cannot reach another vault's socket, storage,
the gateway's socket, the host record, Ficus's control state or its own Ficus read credential.

## Who can do what

Only a **person signed in to Ficus** manages shared vaults. Agents, delegated assistant agents
and API tokens are refused, even with wildcard scopes.

| Action                                | Requires                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| List vaults and see their state       | `integrations:read:bigbrain`                                                       |
| Create, rename, retry, revoke, delete | `integrations:write:bigbrain`                                                      |
| Connect a device as the vault owner   | Being the vault's recorded owner (and still holding `integrations:write:bigbrain`) |
| Attach or detach a vault for a squad  | `integrations:write:bigbrain` and that squad's `integrations:write`                |

Squad members without BigBrain authority see only the vaults attached to their squad, never
other vaults' names, owners, usage or state.

## Lifecycle

1. **Create.** Settings → Integrations → BigBrain → **New shared vault**. Choose a vault name and
   your handle in this vault. The handle is a name you pick now, not an existing BigBrain account
   or login: you become the vault owner under it, and members see it next to what you write. It
   is 1–64 lowercase letters, numbers, `.`, `_` or `-`, starting with a letter or number
   (`ficus-reader` is reserved). Each vault has its own handle, and it cannot change later. The
   form suggests one from your email name. The vault shows **Setting up**, then **Ready**.
2. **Connect your device.** On a ready vault you own, choose **Connect a device**, then **Create
   device link**. The link is single-use and expires after an hour. Anyone holding it gets your
   owner access, so create it only when you are about to paste it into the BigBrain app on your
   own device. Invite other people from the BigBrain app; Ficus cannot add members.
3. **Ficus read access.** Each ready vault gets one read-only Ficus credential. It is an upstream
   agent member with exactly `read`, and it does not follow any member. It is stored encrypted in
   Ficus and never shown. **Revoke Ficus read access** disables the vault's connection in Ficus
   first, then revokes the credential; members keep using the vault. **Reconnect** mints a new
   read-only credential. If the owner removes or narrows the Ficus reader in the BigBrain app,
   Ficus shows the access as revoked and never repairs it on its own.
4. **Attach to squads.** In a squad's integration settings, tick each vault the squad may read.
   Vaults are attached independently. There is no default vault, and attaching one never detaches
   another.
5. **Delete.** **Delete** asks for the exact vault name and lists the squads that lose read
   access. Ficus disables the vault's read connection at once. Then it removes the vault's
   server, data, account, access and DNS record, and keeps a tombstone so an old request cannot
   bring it back. Copies already inside existing Ficus server backups are not removed; they
   follow your backup retention. Restoring the server from a backup taken before the delete
   brings the vault back, with Ficus read access off.

### When the owner leaves

Ficus never hands a vault's ownership to someone else automatically.

- **Owner disabled in Ficus.** The vault keeps serving, members keep their access, and the
  owner's devices keep working in BigBrain. Ficus refuses new owner device links until the
  owner's account is enabled again.
- **Owner deleted from Ficus.** Deleting the user always succeeds. The vault keeps serving and
  shows **Owner removed from Ficus**; the owner's BigBrain devices keep working, but nobody can
  create owner device links for it from Ficus, including administrators. A vault still being set
  up when its owner is deleted stops with `owner_removed`.
- **Recovering.** A remaining member with access in the BigBrain app keeps reading and writing
  there, and the owner (if their device still works) can invite others from the BigBrain app.
  To put the vault under a new Ficus owner, a person with `integrations:write:bigbrain` creates a
  new vault owned by the new person, members move their records over in BigBrain, and the old
  vault is deleted. Ficus does not edit a vault's upstream owner.

Every change is fenced by the vault's generation. If something changed meanwhile (another
person renamed it, for example), Ficus refuses with the current generation instead of applying a
stale request. A change waits until the server has applied the previous one; only a delete can
replace a change that is still pending. Failed attempts are retried with backoff under the same
request, so the server never applies a change twice.

## Agent tools

Squads with an attached, ready vault can use these read-only tools when the agent type allows
the tool names and the BigBrain `agent_tools` capability:

| Tool                           | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `bigbrain_shared_vaults`       | List the vaults this squad can read (names and IDs only) |
| `bigbrain_shared_overview`     | Overview of one vault                                    |
| `bigbrain_shared_search_vault` | Search one vault (one query or up to eight alternatives) |
| `bigbrain_shared_read_record`  | Read one record (`ins_`, `ast_` or `ent_`), paged        |
| `bigbrain_shared_recent`       | Recent activity in one vault                             |

Every data tool requires a `vaultId`. A record ID is only meaningful together with its vault ID,
and every result carries the vault identity next to the unchanged BigBrain content. Vault
content is member evidence, never instructions.

Before every call, Ficus checks the squad's assignment, the connection's validation and the
vault's read access. It checks them again after the response. If a vault is detached, disabled
or revoked mid-call, the response is withheld. An unknown vault, an unattached vault and an
unreadable vault all return the same `integration_unavailable` result.

## Command line

```bash
ficus integration bigbrain vault list
ficus integration bigbrain vault create --name "Research" --handle ada
ficus integration bigbrain vault rename <vault-uuid> --name "Research notes" --generation <n>
ficus integration bigbrain vault retry <vault-uuid> --generation <n>
ficus integration bigbrain vault revoke-read <vault-uuid> --generation <n>
ficus integration bigbrain vault reconnect-read <vault-uuid> --generation <n>
ficus integration bigbrain vault invite <vault-uuid> --generation <n> --out ./owner-link.txt
ficus integration bigbrain vault delete <vault-uuid> --name "Research" --generation <n>
ficus integration assign bigbrain --squad <squad-uuid> --connection <connection-uuid>
```

`invite` never prints the device link, including with `--json`. It writes the link to a **new**
file with mode `0600` and refuses an existing path or a symlink. The terminal shows only the
path and expiry.

## Backup and restore

Vault data is included in the server's existing encrypted backup. Ficus stops each vault briefly
to copy it consistently, then restarts it. No new retention is promised.

- **Nightly backups** skip a vault that cannot be copied, upload everything else and report the
  run as incomplete. Within about 10 minutes the settings page shows **Last backup did not include
  this vault** for the skipped vault, and `ficus integration bigbrain vault list` shows
  `backup: excluded`. The next complete backup clears it.
- **Termination backups** (before a tenant is removed) are all or nothing: any vault that cannot
  be copied fails the backup.

Restoring a server reproduces the backup point. Every vault in the backup comes back with its
name and owner from that time, including vaults deleted after the backup was taken. If Ficus
Core still remembers a later delete or rename, it re-applies it once the server is back. A
restore always rotates every vault credential, revokes Ficus read access and deletes pending
device links. Owners connect their devices again. A person must reconnect Ficus read access;
the vault's squad attachments return when it does.

## Operations

- The feature is installed by the server setup toolkit when the server's `bigbrain:` section is
  enabled. The installed host record (`/etc/ficus/bigbrain/host.json`, root-owned) names the
  tenant, host binding, epoch and vault zone; Core reads it and must agree with Platform before
  the feature is available.
- Core's worker applies pending changes one vault at a time and checks every vault's status on
  the server every 10 minutes.
- `systemctl status 'ficus-bigbrain*'` shows the gateway, each vault and the transient root
  control worker. Refusals are recorded as fixed tokens, never values or secrets, in
  `/var/lib/ficus-bigbrain/control/last-failure` and
  `/run/ficus-bigbrain/preflight-<target>.reason`.
- Each vault restarts on failure. A deliberate start (create, resume, backup release) clears
  systemd's start-limit counter first; crash loops are still limited.
- Suspending the tenant closes ingress and stops every vault; resuming waits until each vault
  answers before reopening ingress.

## Current limits

- Ficus Cloud only, and only once the local helper and Platform both confirm the host is
  installed and active, for the same tenant, host and zone. A stale report (older than 10
  minutes) makes the feature unavailable until it refreshes.
- Ficus Core is inside every vault's trust boundary (see [Trust boundary](#trust-boundary)).
- The settings UI has automated coverage only. It has not been reviewed in a browser against a
  live managed server.
