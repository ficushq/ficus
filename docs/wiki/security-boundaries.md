# Security boundaries

This page preserves the security rationale behind RBAC v2 and the BigBrain integration, reconciled with repository code on 2026-09-08. It describes inspected implementation, not a completed penetration test or proof that every historical acceptance criterion passes. Deferred proposals and verification gaps are in Security follow-ups.

## Identity and permission authority

The current RBAC identity union contains `user`, `agent`, `legacy`, and `system`. User permissions come from role assignments. Agent permissions resolve through the live parent chain to its root authority; cycles, missing or inactive ancestors, and cross-squad parent chains deny authority. User-owned roots resolve through the owner's roles. Other agents receive role and extra-scope permissions only after the squad-access check. Extra scopes must never bypass that check.

System API tokens carry explicit permissions applied globally. The bootstrap `legacy` identity resolves to `*`; it is deliberately privileged. The token resolver accepts the configured bootstrap password only while no admin has a passkey, and compares password hashes with `timingSafeEqual`. Session authentication rejects disabled users, and user-owned agent tokens reject missing or disabled owners. Device tokens resolve to their owning user while retaining device provenance in the authentication context.

Sources: `apps/core/src/services/rbac/permissions.ts` (`Identity`, `resolveAgentAuthority`, `resolveAgentPermissions`, `resolvePermissions`); `apps/core/src/services/auth/resolve-token.ts` (`resolveTokenContext`). The existing AMTP identity implementation is a separate boundary; it does not add a DID or external-agent variant to this RBAC union.

Permission matching is directional. `secrets:read` grants a qualified request such as `secrets:read:integration`; that qualified permission does not grant bare `secrets:read`. A resource name alone, such as `secrets`, is not a wildcard. Explicit `*` and resource wildcards are supported. The shared matcher in `packages/shared/src/permissions.ts` is the authority for backend and frontend semantics.

## Request and live-event enforcement

Protected API handlers must perform an authorization check or explicitly mark a public route. `apps/core/src/middleware/authz-sentinel.ts` checks after the handler completes and replaces unguarded successful responses with a 500. It preserves handler-produced 4xx responses. Because the sentinel runs after the handler, it is a response backstop: write authorization still belongs before side effects. `apps/core/src/middleware/route-coverage.test.ts` is the route coverage check, not a substitute for per-resource authorization.

WebSocket authentication accepts a single-use ticket first, then a token or session cookie. Terminal handshakes additionally check `terminal:access` against the resolved squad; an agent's own box (`agent_<id>`) uses the private-area rule below, and other unresolved squad scope uses the unscoped permission check. Do not describe that fallback as universally “admin only”: system token scopes and other resolver behavior determine the result. Browser handshakes also check allowed origins. See `apps/core/src/index.ts` (`authenticateWsRequest`, `authorizeTerminalRequest`, and the WebSocket routes).

The event manager checks subscriptions and delivery. Current resource scope can require an owner, explicit permission, squad access, or inbox recipient; unavailable resources deny. Global events are intentionally broadly delivered to subscribers, while unrelated null-scope events fail closed for clients without all-squad access. Collection subscription alone is not permission to receive every event. Accessible-squad results are cached and `invalidateAccessCache` clears them; resource-specific checks still matter. See `apps/core/src/services/ws/manager.ts` and `apps/core/src/services/ws/topic-scope.ts`.

An agent's private area (its own box's private dir, holding its identity key and files saved for it alone) is reachable from the Workspace tab only by people: user sessions or the bootstrap `legacy` session, never agents or system tokens. Files need `agents:private-access` in the agent's squad (Admin and Operator by default), or ownership for a squad-less agent; a terminal in the agent's box also needs `terminal:access`. The agent, its squad and `agent_<id>` are resolved from the agent row; only top-level agents with a box of their own qualify. Every miss answers the same 403. Paths are confined below the private root by descriptor-relative `O_NOFOLLOW` walks (`@ficus/shared/confined-fs`), in Core for docker/host and through the box server's `/confined/*` routes for vm/k8s. Dot-prefixed paths and the root `identity.pem` are hidden and refused, not shown read-only, and `chat-attachments/` is read-only. A dormant agent's box is never started from here. Agent-box shells close when the agent is terminated, deleted or goes dormant. See `apps/core/src/services/agent-private/`, `apps/core/src/routes/agent-private.ts` and `apps/core/src/services/sandbox/terminal-access.ts`.

Signed image URLs gate image bytes. Current responses use `private, max-age=<seconds until signature expiry>, immutable`, permitting bounded browser caching while excluding shared caches. This supersedes the old plan's proposed universal `private, no-store`; preserve the privacy boundary without reinstating an obsolete cache choice. See `apps/core/src/routes/images.ts` and `apps/core/src/middleware/identity.ts`.

Expired sessions, passkey challenges, email verifications, and expired or consumed WebSocket tickets are removed by the auth cleanup service. Startup/shutdown wires its scheduler. See `apps/core/src/services/auth/cleanup.ts`, `cleanup-scheduler.ts`, and `apps/core/src/index.ts`.

## BigBrain local process and capability boundaries

The [BigBrain local connector](bigbrain.md) replaces the unused API/token
connector with same-host stdio MCP. The connector documentation records the
pinned upstream smoke and its limits; protocol inspection alone is not a
passing implementation/security test result.

The vault, executable and named local connection are pinned in a host
declaration (`bigbrain-bindings.json` in `HOME_DIR`) that Ficus manages itself
through one-click setup. Core detects the `bigbrain` command under the service
account's OS home, never from a request. A request names only a detected vault
or a Core-host folder, which Core accepts only if it is a real BigBrain vault
(regular `vault.yaml`) with trusted ownership/modes outside agent roots. Setup
is limited to a signed-in person with `integrations:write:bigbrain` and CSRF
protection, and requires explicit confirmation of whole-vault read plus inbox
contribution. Core then runs upstream `bigbrain mcp config` with fixed argv, no
shell, the restricted BigBrain environment, a private cwd, its own process
group, a deadline, output caps and one setup at a time. It schema-parses the
output, keeps only the client ID, and never reads or stores the upstream
credential or upstream output. The declaration is written atomically with mode
`0600` and never through a symlink; a file Ficus did not write is changed only
after confirmation. No caller can supply shell text, argv, environment maps, an
executable or a credential-file path. Core API and Core worker must share the same local filesystem and service
account. Hosted/platform-managed instances are refused, including direct enable
attempts; their effective catalog/runtime state stays disabled without deleting
saved settings. Desktop's **local** runtime and explicitly selected self-hosted
`host` execution are supported under the trusted single-user model. Desktop
attached to a remote/hosted Core does not move the vault or confer eligibility.
Remote agents are supported; there is no remote-vault or browser-local bridge.

No vault, executable, credential file or BigBrain environment is projected to
agents by this connector. On **host** runtime arbitrary agent shells already run
as the service user: private modes, operator declarations and workspace checks
are **not a hostile-agent filesystem boundary** and cannot protect same-user
vaults/credentials from shell access or modification. They remain selection,
configuration and other-user checks. Use an isolated runtime if agents must not
have direct OS access. This is never a boundary against the host administrator
or an already privileged agent runtime.

Squad managers, consultants and squad workers get the read tools automatically
when the squad has a usable attached vault; managers and consultants also get
`bigbrain_drop`. Automatic tools bypass `tools.allow` like squad memory tools, run
the runtime gate under a runner-granted `agent_tools` policy, and are removed by
the agent type's `tools.deny` (names or wildcards). Every other agent type, and a
squad worker that wants `bigbrain_drop`, still needs a version-1 integration
policy allowing `agent_tools` and matching explicit tool allowances. Subagents
never receive BigBrain tools their parent's session did not expose.

Calls recheck squad identity, provider enable, assignment, supported versions,
connection state, material/validation revisions, validation freshness, and the
advertised public-tool capability. Host declaration identity is pinned and
rechecked; editing it cannot silently retarget an existing pooled connection.
BigBrain authenticates each call using its own private local credential and
supplies the contribution's author, not tool input or MCP client handshake text.
Advertised tools alone are not proof of authorization; validation also makes a
bounded read-only call, and upstream enforces the drop scope.

The public Ficus surface is `bigbrain_load_memory`, `bigbrain_search_vault`,
`bigbrain_read_note`, and `bigbrain_drop`. Denying `bigbrain_drop` (or, for an
opted-in type, leaving it out of `tools.allow`) makes an agent read-only through
this connector. An allowed drop can send arbitrary material the agent can
access; it is deliberate outbound contribution, not an automatic
transcript/summary channel. One upstream named credential has one
upstream attribution even when multiple squads use it; the Ficus audit retains
the actual caller identity without recording content.

Each invocation owns bounded stdio/process-group lifetime. Cleanup must include
the upstream CLI's child process on timeout, abort, malformed output, and Core
shutdown. Provider output is untrusted data even if its provenance says trusted;
Ficus's existing tool firewall remains in the path. Raw stderr, credentials,
queries, note bodies, and drop content do not belong in logs or audits. A drop
with a lost response has an unknown outcome and is never automatically replayed.

## Managed shared BigBrain vaults (Ficus Cloud)

[Managed shared vaults](bigbrain-shared-vaults.md) run as separate BigBrain servers on a
tenant's existing Core server. **Ficus Core is inside their trust boundary:** hosted Core runs
as `root` and reads each vault's root-only Ficus read handoff directly, so a compromise of Core
on that server is a compromise of every managed vault on it. This was an explicit product
decision; no document, test or release note may claim that the Core service account is denied
access to vault material or owner escrow.

Enforced boundaries, each covered by the disposable Linux containment lane
(`scripts/bigbrain/linux-acceptance.ts`): each vault runs under its own unprivileged account,
fixed-size ext4 image, systemd memory/task limits and bounded scratch, with no IP sockets
(seccomp `AF_UNIX` only), private network and IPC namespaces, no namespace creation, a native
`@system-service` syscall filter without privileged or resource-control calls, and a
root-prepared Unix socket only the gateway group can reach. A
vault cannot reach another vault's socket or storage, the gateway's socket, the host record,
control state, its read handoff, owner escrow or the root launcher, before or after restarts.
The gateway is credential-free and routes by host name. It limits each vault and the host with
token buckets and in-flight caps (429 `busy`). One exception keeps a join from spending an invite
for nothing: a successful invite redeem reserves the single `whoami` that follows it, for that
vault and the returned credential only, keyed by a SHA-256 hash (never the credential), single
use, at most 16 at once and for 30 seconds. Reserved requests have their own in-flight cap (one
per vault, two per host), so in-flight never exceeds the normal caps plus two; a reserved `whoami`
that finds its cap full waits up to 5 seconds for a slot instead of being refused.

Ficus reads with an upstream agent credential that has exactly `read` and follows no member,
re-verified on every call. Agents see five read tools that require an explicit vault and resolve
it only through their squad's assignment; there is no default vault and no write tool. Shared
tools are created only for agents on an isolated sandbox runtime, never `host`. Management is
literal-human only (no agent, delegated assistant or system token). Vaults belong to the
instance: their BigBrain owner is `ficus`, and any `integrations:write:bigbrain` holder may
create an owner device link, which grants full owner access. Links are secret, single-use and
never cached or logged; Core audits who requested each one (never the link). Owner escrow stays
inside the root control worker and never crosses a Core API, Platform response or log.

The same literal humans manage members through Core (list, invite, cancel an invite, change
access between read and read-and-write, remove); listing needs the write permission too, because a
roster names people and pending invitations. The root controller runs a small pinned adapter as
the vault's own account that calls only the upstream member/invite exports, never a credential or
token API. It never changes or removes the owner or the `ficus-reader` member and never grants the
owner role. Member invite links are secret like owner links: returned once, never cached or
logged, replayed only from a root-only cache so a retry never mints a second invite. Rosters carry
display fields only (no emails, identities or credentials). Core audits each change by actor,
vault and member handle, never the link.

Core is the authority for vault operations: it records each change with a generation fence and
runs it on the same server through the root helper `/usr/local/libexec/ficus-bigbrainctl`,
using a bounded spawn with a capped reply and no sudoers, setuid binary or socket service.
Platform keeps no per-vault records. It reports installation and the vault zone, manages only
the exact DNS record for each vault (host name, tenant/vault owner tag and provider record ID;
never wildcard deletion), and runs tenant suspend, resume, termination backup and restore.
Restore reproduces the backup point, including vaults deleted later, with every credential
rotated and Ficus read access revoked; Core then re-applies its own later deletes and renames.

## No automated transcript export

There is no `conversation_export` integration capability, `integrations:export`
permission, external-export route or consent UI, completion listener, projection
job, encrypted export outbox, retry worker, or BigBrain session sender in the
replacement. No automatic summary/drop replaces it. Export-only schema is
removed by a generated forward migration, not live SQL or a legacy migration
service. Deploying this change later requires replacing both API and worker so
an old exporter cannot remain resident.

Ordinary Ficus conversation history, manual downloads, internal memory features,
shared integration credential cleanup/revalidation, OAuth projection, workflow
outputs and unrelated integrations must remain intact. The `integrations/export`
subtree is export-specific; the separate `integrations/projection` subtree is
shared credential/tool projection and is not removed.

## Historical rationale and verification pointers

The preserved sources are `docs/history/plans/2026-06-17-rbac-v2-design.md`, `docs/history/plans/2026-06-17-rbac-v2-plan-3-deferred-security.md`, `docs/history/decisions/2026-08-14-integrations-bigbrain.md`, and `docs/history/plans/2026-08-14-integrations-bigbrain.md`. Historical “deferred security” titles do not imply their entire implementation remains unfinished.

Useful regression sources include `apps/core/src/services/auth/resolve-token.test.ts`, `apps/core/src/services/ws/manager.test.ts`, `apps/core/src/services/integrations/runtime-gate.test.ts`, `apps/core/src/entities/agent-runners/base.integration-tools.test.ts`, and the focused BigBrain host-binding, transport, tool, and removal tests specified by the local connector contract. They identify intended boundaries; their presence is not a current passing-test result.
