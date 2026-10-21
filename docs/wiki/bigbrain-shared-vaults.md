# Managed shared BigBrain vaults (Ficus Cloud)

> Containment verified on a disposable Linux runner (two vaults, attacks from inside a vault,
> disk exhaustion, backup staging, revoke, suspend/resume and delete). Not yet released.

On Ficus Cloud, a team can run several [BigBrain](https://bigbrain.cool) vaults **on its own
Ficus server**. The vaults belong to the Ficus server, not to one person. People read and write
a vault from the BigBrain app. Chosen squads can **read** it through five read-only agent tools.
Ficus agents never write to a shared vault, and Ficus never imports conversations into one.

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
| Credentials | Its own `ficus` owner, members and one read-only Ficus credential                      |

All vaults together are capped at 640 MiB of memory and 50% of one CPU. A server hosts at most
two vaults. Ficus keeps at least 2 GiB free for itself before it creates another vault.

## Who decides

**Ficus Core on the tenant's server is the authority for its vaults.** Core records every
create, rename, retry, read revoke or reconnect, owner device link, member change and delete in
its own database (member changes in its audit log), and runs each one on the same server through a local root helper
(`/usr/local/libexec/ficus-bigbrainctl`). No other service keeps a list of the vaults.

Ficus Cloud's Platform does only these things for managed BigBrain:

- install the feature on a server when it is enabled for the tenant;
- report whether the server is installed and active, its vault zone and the tenant label used
  for new vault addresses;
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
  response or log carries it. The single-use device link is returned only to the person with
  `integrations:write:bigbrain` who requested it, and Core audits who that was.
- Member invite links are returned the same way, once, to the person who created them. Core never
  stores, caches or logs them; only the root control worker keeps a copy, so that a retried
  request returns the same link. Member lists carry display fields only.
- Ficus never changes or removes a vault's owner or its `ficus-reader` member, and never makes
  anyone an owner.

Requests reach a vault only through a small gateway. Caddy terminates TLS for the vault's
address (see [Vault addresses](#vault-addresses)) and forwards to the gateway's Unix socket. The gateway selects the vault
by host name and holds no credentials. A vault cannot reach another vault's socket, storage,
the gateway's socket, the host record, Ficus's control state or its own Ficus read credential.

## Vault addresses

Each vault has one HTTPS address, chosen when it is created and never changed afterwards:

- `https://<tenant>-bb-<short id>.<zone>`, for example `https://noah-bb-7b0a25fe1d6a.ficus.sh`.
  `<tenant>` is the tenant's Ficus Cloud subdomain and `<short id>` is the first 12 hex
  characters of the vault ID (dashes removed);
- `https://bb-<vault id, 32 hex>.<zone>` when there is no tenant label, or when
  `<tenant>-bb-<short id>` would be longer than one 63-character DNS label (tenant names over
  47 characters). Vaults created before tenant-prefixed addresses keep this form.

One shared function (`managedBigbrainVaultHostname` in `packages/shared/src/managed-bigbrain.ts`)
applies this rule; nothing else builds a vault address. Core takes the tenant label only from the
installed host record (`tenant_label` in the server's `bigbrain:` setup section, written by
Platform), and only when Core's local probe, Platform's report and the host record all agree on
it. It never comes from a request or a `Host` header. A new vault whose short ID matches any
other vault of the tenant, including deleted ones, gets a new vault ID before anything is
created.

The address is stored with the vault and on the server's receipt, sent to Platform for its DNS
record (a `bb-<32 hex>` vault sends an empty body, as before), and kept in backups. It is not derived again later, so renaming the tenant changes only
the addresses of vaults created afterwards. A restore keeps each vault's address form and moves
it to the restoring server's zone. Every check accepts only these two forms for the vault: when
a vault is created, the server accepts only the fallback address or the prefixed address with its
installed tenant label and zone. Later checks (gateway routes, Caddy sites, units, Core's read
client) check a stored address against its vault only, so an address recorded under an earlier
tenant label keeps working. The server also refuses a new vault whose address another recorded
vault already has, and the gateway refuses to load two routes for one address. Tenant subdomains that start with `bb-` or end in `-bb-` plus
12 hex characters are reserved (`managedBigbrainReservesLabel`) and Platform must refuse them,
so a tenant name cannot clash with a vault address.

## Who can do what

Only a **person signed in to Ficus** manages shared vaults. Agents, delegated assistant agents
and API tokens are refused, even with wildcard scopes.

| Action                                | Requires                                                            |
| ------------------------------------- | ------------------------------------------------------------------- |
| List vaults and see their state       | `integrations:read:bigbrain`                                        |
| Create, rename, retry, revoke, delete | `integrations:write:bigbrain`                                       |
| Connect a device as the vault owner   | `integrations:write:bigbrain`                                       |
| List a vault's members and invites    | `integrations:write:bigbrain`                                       |
| Invite, cancel, change access, remove | `integrations:write:bigbrain`                                       |
| Attach or detach a vault for a squad  | `integrations:write:bigbrain` and that squad's `integrations:write` |

Squad members without BigBrain authority see only the vaults attached to their squad, never
other vaults' names, owners, usage, state or members.

Listing members needs the write permission, not just `integrations:read:bigbrain`: a member list
names people and their pending invitations, which only the people who can change it need, and
every list runs the server's root helper. People with read-only BigBrain authority see each vault
and its state, but not its members.

### The owner in BigBrain

A BigBrain vault always has exactly one owner member. In a shared vault that owner is `ficus`
(display name "Ficus"), set by Ficus when it creates the vault; nobody chooses it. It is not a
Ficus user. **Anyone with `integrations:write:bigbrain` can connect a device as this owner**, so
know what that grants:

- The owner has full access in BigBrain: it reads and writes everything and manages members.
  Anyone holding an unused owner device link gets the same access until the link expires.
- Everyone who connects as the owner writes as the same `ficus` member. To give people their own
  name in the vault, invite them as members (see [Members](#members)).
- Core records each owner device link request (who asked, for which vault) in the integration
  audit log. The link itself is never recorded.

Vaults created before this rule keep the owner handle chosen then. Their creator's Ficus user ID
remains only as an internal anchor for the server helper; deleting that user no longer affects
the vault. A vault whose creator was deleted while that was still a user reference shows that
owner device links are no longer available; its existing owner devices keep working.

## Lifecycle

1. **Create.** Settings → Integrations → BigBrain → **New shared vault**. Choose a vault name; the
   owner in BigBrain is always `ficus`. The vault shows **Setting up**, then **Ready**.
2. **Connect an owner device.** On a ready vault, a person with `integrations:write:bigbrain`
   chooses **Connect owner device**, then **Create device link**. The link is single-use and
   expires after an hour. It grants full owner access (see
   [The owner in BigBrain](#the-owner-in-bigbrain)), so create it only right before pasting it
   into the BigBrain app on the device to connect. To give people their own name in the vault,
   invite them as members instead (see [Members](#members)).
3. **Ficus read access.** Each ready vault gets one read-only Ficus credential. It is an upstream
   agent member with exactly `read`, and it does not follow any member. It is stored encrypted in
   Ficus and never shown. **Revoke Ficus read access** disables the vault's connection in Ficus
   first, then revokes the credential; members keep using the vault. **Reconnect** mints a new
   read-only credential. If someone connected as the owner removes or narrows the Ficus reader in
   the BigBrain app, Ficus shows the access as revoked and never repairs it on its own.
4. **Attach to squads.** In a squad's integration settings, tick each vault the squad may read.
   Vaults are attached independently. There is no default vault, and attaching one never detaches
   another.
5. **Delete.** **Delete** asks for the exact vault name and lists the squads that lose read
   access. Ficus disables the vault's read connection at once. Then it removes the vault's
   server, data, account, access and DNS record, and keeps a tombstone so an old request cannot
   bring it back. Copies already inside existing Ficus server backups are not removed; they
   follow the server's backup retention. Restoring the server from a backup taken before the
   delete brings the vault back, with Ficus read access off.

## Members

On a ready vault, **Members** lists who is in the vault: the owner, Ficus's read-only member
`ficus-reader`, and everyone else. The owner and `ficus-reader` are system members: shown, never
editable. Members added by email from the BigBrain app show as pending until they sign in.
Pending invites are listed with their name, access and expiry, never their link.

- **Invite member.** Enter the person's name and choose **Read** or **Read and write**. Ficus
  creates an invite link that works once and expires after 24 hours. It is shown once, in the
  dialog, and never stored by Core or the browser. Send it only to that person, privately:
  whoever redeems it first in the BigBrain app becomes the member. Redeeming creates a new member
  with its own handle, `invite-<invite ID>`, and the name from the invite. Everything that
  member writes is attributed to that handle and name, including in what Ficus agents read.
  Retrying the same request (a lost response, for example) returns the same link; it never
  creates a second invite. At most 32 invites created through Ficus can be pending per vault.
  Cancelled and redeemed invites stop counting; an invite whose result was lost keeps counting
  until it expires, because Ficus cannot tell whether it was created.
- **Cancel invite.** The link stops working at once. An invite that was already redeemed cannot
  be cancelled; remove the member instead.
- **Change access.** Read, or read and write. It applies to the member's next request on every
  device they connected. The owner's access is fixed.
- **Remove.** Ends the member's access on every device at once by revoking the member and every
  credential it holds. What they wrote stays in the vault under their name. Their handle stays
  reserved and is never reused, so removal cannot be undone; invite the person again to give them
  access back, as a new member with a new handle.

Core records each invite, cancellation, access change and removal in the integration audit log:
who did it (`user:<id>`), the vault, and the member handle (for invites, the handle the member
will get), never the link. Each person can create 20 invites and make 60 other member changes an
hour, and list members 60 times a minute.

Member changes need the server helper that ships with this release (see
[Operations](#operations)); a server that has not been upgraded refuses them with
`invalid_request`.

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
ficus integration bigbrain vault create --name "Research"
ficus integration bigbrain vault rename <vault-uuid> --name "Research notes" --generation <n>
ficus integration bigbrain vault retry <vault-uuid> --generation <n>
ficus integration bigbrain vault revoke-read <vault-uuid> --generation <n>
ficus integration bigbrain vault reconnect-read <vault-uuid> --generation <n>
ficus integration bigbrain vault owner-link <vault-uuid> --generation <n> --out ./owner-link.txt
ficus integration bigbrain vault members <vault-uuid>
ficus integration bigbrain vault invite <vault-uuid> --name "Grace Hopper" --access write --generation <n> --out ./grace-invite.txt
ficus integration bigbrain vault cancel-invite <vault-uuid> <invite-id> --generation <n>
ficus integration bigbrain vault set-access <vault-uuid> <member-handle> --access read --generation <n>
ficus integration bigbrain vault remove-member <vault-uuid> <member-handle> --generation <n>
ficus integration bigbrain vault delete <vault-uuid> --name "Research" --generation <n>
ficus integration assign bigbrain --squad <squad-uuid> --connection <connection-uuid>
```

`owner-link` and `invite` never print their link, including with `--json`. Each writes the link
to a **new** file with mode `0600` and refuses an existing path or a symlink. The terminal shows
only the path and expiry (and, for `invite`, the invite ID). `invite` always creates a member
invite and needs `--name`; `--access` defaults to `read`. The owner device link is `owner-link`.

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
device links and member invites. Owner devices are connected again. Members keep their names
and what they wrote, but their devices are disconnected too, and Ficus cannot reconnect an
existing member's devices: invite them again, as new members with new handles. A person must reconnect Ficus read access;
the vault's squad attachments return when it does.

## Operations

- The feature is installed by the server setup toolkit when the server's `bigbrain:` section is
  enabled. The installed host record (`/etc/ficus/bigbrain/host.json`, root-owned) names the
  tenant, host binding, epoch, vault zone and optional tenant label; Core reads it and must agree
  with Platform before the feature is available.
- Core's worker applies pending changes one vault at a time and checks every vault's status on
  the server every 10 minutes.
- `systemctl status 'ficus-bigbrain*'` shows the gateway, each vault and the transient root
  control worker. Refusals are recorded as fixed tokens, never values or secrets, in
  `/var/lib/ficus-bigbrain/control/last-failure` and
  `/run/ficus-bigbrain/preflight-<target>.reason`.
- Member management runs the installed release's member adapter (`bigbrain-members.js`) as the
  vault's own account, even for vaults created on an earlier release: every release runs the same
  pinned upstream, so the member store is the same. It calls only the upstream member and invite
  functions. A tenant gets it only through a separately authorized upgrade of the server toolkit
  together with Core; until then the helper refuses member actions.
- Each vault restarts on failure. A deliberate start (create, resume, backup release) clears
  systemd's start-limit counter first; crash loops are still limited.
- Suspending the tenant closes ingress and stops every vault; resuming waits until each vault
  answers before reopening ingress.
- Each ready vault has a Caddy site file in `/etc/ficus/bigbrain-caddy/`, which the Caddyfile
  imports. The directory sits outside the root-only `/etc/ficus/bigbrain` because Caddy runs and
  reloads as the `caddy` user. An import glob over a directory that user cannot read matches
  nothing, and Caddy then answers the vault's host name with an empty `200`. The BigBrain app
  reports that as `null is not an object (evaluating 'result.vault')`. Publishing the sites, and
  creating an owner device link, fail with `tls_unavailable` instead of leaving a vault
  unreachable. A request that never reached the vault does not use up its device link.
- Installing or upgrading the runtime **restarts** the gateway and succeeds only when the new
  process answers from the published routes and runs the installed release. `systemctl enable
--now` and `start` leave a running process alone. An earlier installer used them, so after an
  upgrade the gateway kept running the previous release. That release accepted only
  `bb-<32 hex>` addresses, rejected the route list once it held a tenant-prefixed vault, and
  answered every vault host `503 {"code":"not_installed"}` while its unit was `active`. The
  BigBrain app reports any failed redeem as "Invitation is expired, already used, or
  unavailable". Vault services stay on the release recorded when the vault was created, so an
  upgrade does not restart them.
- The probe (Core's and Platform's) reports the feature available only when the running
  processes serve. The gateway's main process must run the installed release, and each ready
  vault's process must run its recorded release. The gateway must answer an unrouted host with
  its own `404` (so it has loaded the routes), and a credential-free `/v1/whoami` must return
  `401` with `BigBrain-Protocol` through the gateway for every ready vault. Otherwise the reason
  is `upstream_unavailable`. Creating an owner device link runs the same check for its vault
  first and fails with `upstream_unavailable` instead of issuing a link that cannot be redeemed.
- Core answers any vault host name with `404 {"code":"not_found"}` before its own session or
  identity handling. Caddy sends only Core's exact host to Core, so this is a second guard.
- A host upgraded from an affected release recovers through the normal upgrade. The installer
  restarts the stale gateway onto the new release. No manual host edits are needed.

## Current limits

- Ficus Cloud only, and only once the local helper and Platform both confirm the host is
  installed and active, for the same tenant, host, zone and tenant label. A stale report (older than 10
  minutes) makes the feature unavailable until it refreshes.
- Ficus Core is inside every vault's trust boundary (see [Trust boundary](#trust-boundary)).
- The settings UI has automated coverage only. It has not been reviewed in a browser against a
  live managed server.
