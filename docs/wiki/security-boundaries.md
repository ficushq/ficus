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

## Tool credential detection

Connection credentials are registered with the process-local content-safety matcher
as secret leaf values, not serialized bundles. This includes manual provider tokens,
channel credential leaves, and OAuth access/refresh tokens. OAuth expiry, revision,
and client binding identifiers are not secrets. Connection material is identified
by the internal `__integration-credential:` storage namespace. Secret leaves must
contain at least 8 characters to be exact-matched; shorter legacy values are not
exact-matched, and new manual/channel credential inputs enforce the same floor.
Opaque manual tokens are trimmed consistently before route validation, storage
and execution; existing padded values are matched as their effective trimmed
tokens. The eight-character floor applies after that normalization. OAuth and
channel bundle leaf strings are not blindly trimmed. Credential-pattern detection
is independent of this exact-match minimum. Other
encrypted stored values retain their existing minimum length (12 characters) and
public-key / identifier exclusions. Storage, transactional OAuth refresh, rotation,
deletion, initial cache loading and cross-process cache refresh all use the same
matcher publication path. Union publication protects both sides of a rotation.
Retired integration leaves remain matched for one hour from replacement/deletion,
including while provider revocation is pending and across API/worker restarts.
The prior encrypted bundle and an absolute deadline are persisted in a separate
protected retirement table in the same transaction as the credential mutation.
Ordinary Secret Store get/list APIs do not expose retired material. Per-key
transaction locks serialize concurrent first writes, rotations and deletion.
Startup and peer cache refresh restore only secret leaves, not bundle envelopes
or OAuth metadata. Neither unrelated updates nor late refreshes renew the deadline.
Expiry is checked at redaction boundaries; normal full cache refresh also removes
expired durable rows. Integration retirement remains encrypted and independent
of the env-only authority table described below.

Integration credentials and remaining matchable stored secrets are redacted from
tool output and refuse matching tool input before execution. Refusal/audit details
contain key identifiers only, never credential values. This is leak containment,
not a restriction on what `ficus integration exec` may execute, and not a guarantee
against transformed/encoded secrets or a malicious agent that already holds one.
Channel plugins still do not deliver credentials to sandboxes.

Squad Environment Variables are **output-only** detection entries: they never
refuse input or produce stored-credential tool audit matches. An agent may use a
custom value to write an application's `.env.local`. If the same value is also an
integration or protected stored credential, that independent input protection still
applies. Output redaction (including partial streaming/truncated fragments) applies
to both policies.

The env heuristic uses statically decoded shell-literal assignments from canonical
squad `.ficus/env.user` only. Unquoted literals, single/double quotes, concatenated
quote fragments, shell backslash escaping/line continuation, multiline quotes and
Bash ANSI-C quotes are decoded without running a shell. For ANSI-C Unicode escapes,
both UTF-8 and C-locale escaped representations are conservatively registered; the
detector does not read or change a runtime locale. An embedded unquoted `#`
is part of the value; only a `#` starting a shell word begins a comment. Assignment
words and `export` declarations (including multiple assignments and semicolon
separators) are recognized; arbitrary command arguments and heredoc bodies are not
interpreted as environment definitions. The detector never evaluates variables,
parameter/command/arithmetic/process substitutions, or locale-dependent quotes.
Such dynamic values and malformed/unsupported statements are not inferred. This
is not an interpreter for arbitrary shell scripts or control flow.

After literal decoding, the heuristic is:

- Public/publishable key names and `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` prefixes
  are excluded, case-insensitively.
- Values under 12 characters are not registered (for example `production`).
- Keys ending in `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, `_CREDENTIALS`, or those
  exact bare names, case-insensitively, match every value at least 12 characters.
- Other keys require at least 32 characters, at least 4 Shannon bits per character,
  and at least two of lowercase, uppercase, digits and non-alphanumeric characters.
  Whitespace-containing values, HTTP(S) URLs, and absolute or explicit relative/home
  paths are excluded on this entropy-only path. Repeated values, ordinary words
  and common UUID identifiers do not meet the rule. This is a heuristic, not a
  classification guarantee for every possible configuration value. Hex-only secrets
  under generic names commonly score below 4 bits and are not reliably matched;
  use an explicit secret-suffixed name for those values.

Environment detection authority lives in a dedicated protected DB table containing
only the content hash and parsed squad-env entries, never integration credentials.
It has no encryption-key dependency: Core's supported no-key startup and env edits
still work. At upgrade, existing squads receive one bounded legacy snapshot; this
explicitly trusts their initial `env.user` bytes once. A separate durable per-squad
bootstrap marker prevents a missing or malformed record from authorizing another
snapshot. New squads are marked already bootstrapped and need an API/service write
to register values. Generic squad updates cannot reset that marker.

After bootstrap, only API/service environment writes update the trusted record.
An on-disk file whose hash differs is ignored for detection, not parsed into new
entries. A fixed warning is logged once per squad per process, and Environment
settings show a nonsecret notice explaining that the content must be saved there.
Users with env-write permission can explicitly re-save unchanged content while
that notice is present (including Ctrl/Cmd+S); pending/read-only submissions stay
disabled, and successful registration clears the notice after re-fetch.
Settings GET reads are separately bounded at 256 KiB for both `env.user` and the
legacy `.env` fallback, including file growth during reads. Oversized content
returns HTTP 413 (`squad_env_too_large`), never an editable prefix or empty
substitute. The file is left unchanged. Settings shows an explicit error with no
editor/Save, including when an older query value is cached; saves also wait for
pending reads. Reduce the file outside Settings, reload, then save the smaller
content there to register output redaction. Unsafe/unreadable files return a
controlled 409 without falling back to generated content. Generic runtime env
regeneration and strict cleanup retain their existing full-content behavior.
Legacy files above 256 KiB are skipped with a warning; API/service writes enforce
the same UTF-8 byte cap before any file write. Bounded reads also tolerate a file
growing after its metadata check. Symlink settings and files are not followed.

The process-wide source enumerates DB squad records, not workspace directories.
Startup awaits bootstrap; an owned periodic runner refreshes DB snapshots in both
API and worker. Synchronous file checks are throttled to once per second, checking
only `env.user` metadata and reusing hash-validated entries. API/service writes
refresh their process immediately; peer refresh and file-check intervals mean
cross-process changes are not instantaneous. No shell parsing or DB work happens
for every streamed chunk. Matching across squads is deliberately allowed; these
values are never used for input refusal. No arbitrary workspace files (including
app `.env.local` files) are scanned or registered. Dynamic shell expressions are
not evaluated, so their resulting runtime values are not inferred.

Regression pointers: the focused content-safety, content-safety-registry,
squad-env-secret-source, stored-secret-tool-containment, secrets/store and squad/env
tests cover the policies and their lifecycle boundaries.

## Historical rationale and verification pointers

The preserved sources are `docs/history/plans/2026-06-17-rbac-v2-design.md`, `docs/history/plans/2026-06-17-rbac-v2-plan-3-deferred-security.md`, `docs/history/decisions/2026-08-14-integrations-bigbrain.md`, and `docs/history/plans/2026-08-14-integrations-bigbrain.md`. Historical “deferred security” titles do not imply their entire implementation remains unfinished.

Useful regression sources include `apps/core/src/services/auth/resolve-token.test.ts`, `apps/core/src/services/ws/manager.test.ts`, `apps/core/src/services/integrations/runtime-gate.test.ts`, `apps/core/src/entities/agent-runners/base.integration-tools.test.ts`, and the focused BigBrain host-binding, transport, tool, and removal tests specified by the local connector contract. They identify intended boundaries; their presence is not a current passing-test result.
