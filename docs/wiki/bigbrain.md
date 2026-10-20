# BigBrain local vault connections

> Local connector verified against the pinned upstream on Linux on 2026-10-20.
> Packaged macOS end-to-end validation is outstanding; no Desktop release is implied.
> This page describes the local MCP connector, not the removed API/token adapter.
> On Ficus Cloud, see [managed shared BigBrain vaults](bigbrain-shared-vaults.md) instead. There,
> Ficus Core is trusted with every shared vault on the tenant's server.

[BigBrain](https://bigbrain.cool) is a self-hosted memory engine, not a BigBrain-hosted cloud service.
Ficus connects to an explicitly selected local vault using BigBrain's public
stdio MCP server. The engine owns the record, indexes, credential checks, and
contribution attribution. Ficus does not read notes directly or write its logs.

**Ficus does not automatically capture or send conversation transcripts.** There
is no replacement background summary/drop job. Agents with the separately
allowed contribution tool can deliberately save useful findings. Ordinary Ficus
conversation history and manual downloads are unaffected.

## Supported deployment

Supported: **Ficus Desktop's local runtime**, and explicitly configured
**self-hosted Core**, with BigBrain on the same machine as Core.

- Desktop's local runtime runs Core API and worker on your Mac as your user,
  using `FICUS_SANDBOX_RUNTIME=host`. It needs no Docker or VM for this connector.
  Explicitly selected self-hosted `host` runtime is supported on the same terms;
  the Desktop marker does not grant authority or bypass deployment checks.
- Core API handles setup/validation. Core worker handles agent tools and periodic
  connection validation. Both must see the same BigBrain command, vault,
  credential state and Ficus home under the same service account/filesystem
  namespace. Split API/worker hosts are not supported.
- A Desktop app **attached to a remote instance**, browser, mobile app or CLI
  sets up BigBrain on the connected **Core host**, not on the client.
  Desktop attached to Ficus Cloud cannot reach BigBrain on your Mac. Self-hosted
  remote **agent** execution (`vm`/`k8s`) remains supported when BigBrain is local
  to Core; remote **vault** execution, remote mounts and SSH bridges are not.
- Hosted/platform-managed Core, Windows, and missing/unknown agent runtimes are
  unsupported. BigBrain stays under **Disabled**, with a visible reason, even
  when an old enabled flag is saved. Enable attempts are refused server-side;
  saved settings/connections are retained. A missing BigBrain install or vault
  on an eligible host means **setup required**, not an unsupported deployment.
- **Host runtime is trusted single-user execution, not filesystem isolation.**
  Agent shells run as the same OS user and can access/modify the user's vault,
  executable and credentials outside the connector. Connector permission gates,
  private file modes, ownership and workspace-overlap checks still apply, but
  cannot contain a hostile same-user agent. Use isolated agent execution when
  that boundary is required. See [host runtime](host-runtime.md).
- The connector projects only four tools, not vault mounts, executables,
  credentials or `BIGBRAIN_*` variables into agent environments. On isolated
  runtimes this keeps vault files outside ordinary agent mounts. On host runtime
  it does **not** prevent direct shell access. Keep these files outside all
  agent workspaces in either case.

The upstream desktop distribution is Apple-silicon macOS-only. The stdio engine
also has a source-checkout entry point; a Linux source install needs a successful
local transport smoke test. Ficus makes no claim that the whole upstream desktop
application is supported on Linux. Ficus never downloads or installs BigBrain.

## Upstream contract and provenance

Protocol inspection is pinned to
[`elsehow/bigbrain@cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed`](https://github.com/elsehow/bigbrain/tree/cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed).
Its `package.json` and root license declare AGPL-3.0-only; Ficus is also
AGPL-3.0-only. This adapter is independently implemented from protocol behavior:
no BigBrain implementation, tests, or skill prose is vendored or copied, and
BigBrain is not a Ficus package dependency. This replaces the older provenance
statement about an earlier snapshot without an observable root license; it does
not retroactively change that historical snapshot's provenance.

The upstream material is not entirely synchronized at this revision:

- `docs/agent-memory.md`, `bin/mcp.ts`, and `ConnectedClients.stdio()` support
  named stdio connections. `bigbrain mcp config` emits this form.
- `ConnectedClients.setup()` and the desktop release notes now favor local HTTP
  MCP at the app's `/mcp` endpoint. The stdio implementation explicitly describes
  itself as retained while that transition proceeds. Ficus does **not** import
  the desktop's HTTP setup or infer that self-hosting means no HTTP APIs exist.
- The search skill mentions a memory `topic`; the actual `load_memory` schema
  accepts no arguments and reads the working set. Ficus follows the wire
  implementation, not this stale skill sentence.
- `drop` can return either a saved evidence receipt or `{ queued: true, id }`.
  The latter is waiting on upstream intake, not a saved/curated note.

Relevant upstream files at the pin: `bin/mcp.ts`, `lib/mcp.ts`,
`lib/vaultTools.ts`, `lib/noteWindow.ts`, `lib/connectedClients.ts`,
`lib/mcpRegister.ts`, `lib/engine.ts`, `lib/auth.ts`, `lib/agentReads.ts`, and
`clients/shared/skills/vault-search/SKILL.md` / `vault-add/SKILL.md`.
Recheck compatibility after an upstream update. If stdio is removed, report an
unsupported protocol; do not silently switch transport, credential, or vault.

## Setup

1. Install and open **BigBrain.app** on the machine that runs Ficus (for Ficus
   Desktop, your Mac), using the same account. Opening it installs the
   `~/.local/bin/bigbrain` command Ficus uses. Create or choose your vault there.
2. In **Settings → Integrations → BigBrain**, enable the provider and click
   **Connect BigBrain on this Mac** (on Linux hosts: **on the Ficus host**).
3. Confirm the vault. Ficus lists the vault BigBrain itself opens (its
   `~/.config/bigbrain/vault` pointer, else `~/vault`) and any vault already
   connected. You can instead type the full path of another vault folder on the
   Ficus host; it must contain `vault.yaml`. The confirmation states that the
   connection can **read the whole vault and drop notes into its inbox**.

Ficus then runs BigBrain's own setup, turns the connection on and lists it.
Assign it to squads in their integration settings. Running **Connect BigBrain**
again for the same vault reuses the same BigBrain connection and the same Ficus
connection: it never mints duplicates. If BigBrain moved or its connection
changed, running it again repairs the connection in place, so squads keep their
selection.

### What Connect BigBrain does

- Core finds `~/.local/bin/bigbrain` under the **Core service account's OS
  home** itself. The browser, CLI or API never supply an executable, argv,
  environment or token path. The command and its resolved target must be owned
  by that account or root, not group/world writable, and outside Ficus agent
  workspace roots.
- A chosen vault must be an existing directory with a regular `vault.yaml`, with
  the same ownership/permission checks, outside agent roots. Core never searches
  disks, runs `init`, or installs BigBrain.
- Core runs `bigbrain mcp config` with fixed argv, no shell, the vault in
  `BIGBRAIN_VAULT`, the restricted BigBrain environment (OS `HOME` preserved,
  Ficus secrets and inherited `BIGBRAIN_*` overrides dropped), a private
  temporary working directory, its own process group, a 20 s deadline and a
  64 KiB output cap. One setup runs at a time. At the pinned upstream this calls
  `ConnectedClients.ensure("Local MCP configuration", "generic", "cli:config")`:
  it creates or reuses one named generic connection with `vault:read` and
  `inbox:write`, keeps its credential in BigBrain's private store under OS
  `HOME`, and prints the stdio launch entry. Ficus parses that output with a
  schema, requires it to name the selected vault without a token-store override,
  and keeps only the 8-hex `--client` ID. Ficus never reads or copies the
  credential. Upstream stdout/stderr is never shown, logged or stored; failures
  become fixed messages.
- Ficus writes `bigbrain-bindings.json` in its `HOME_DIR` (Desktop: its local
  data directory, usually `~/.ficus/desktop`) atomically, mode `0600`, never
  through a symlink. The file is Ficus-managed: Ficus creates it, updates it
  when the command or connection changes, and removes a vault's entry when its
  last Ficus connection is removed. An existing file Ficus did not write is kept
  as it is until you confirm that Ficus may manage it (its vaults are kept).
- Ficus then validates and enables the connection through the normal lifecycle.
- Removing a Ficus connection does not revoke BigBrain's connection. Revoke
  “Local MCP configuration” in BigBrain.app under Connected Clients when access
  should end. This is the same connection any other client set up with
  `bigbrain mcp config` uses for that vault, so revoking it disconnects those
  clients too.

Equivalent CLI inspection (connecting needs a signed-in person in the web UI):

```sh
ficus integration local-bindings bigbrain
ficus integration enable "$CONNECTION_ID"
ficus integration assign bigbrain --squad "$SQUAD_ID" --connection "$CONNECTION_ID"
```

A Ficus connection pins the resolved vault, executable target and client ID.
Changing them outside Ficus invalidates the pin; it never silently retargets
squads. Run **Connect BigBrain** again to re-pin.

## Permissions and connection lifecycle

Global provider enablement, the enabled pooled connection, squad selection,
agent-type capability, and explicit tool allowance must all permit access.
Existing instance-scoped `integrations:read:bigbrain` /
`integrations:write:bigbrain` permissions govern the pool. **Connect BigBrain**
also requires a signed-in person (not an agent, system token or bootstrap
session) and the CSRF header for cookie sessions. Squad-scoped grants cannot
reveal host paths or run setup. Integration write permission cannot make Core
run an uploaded executable or an arbitrary command: Core only runs the
`bigbrain` command it detected, with fixed argv, against a vault a person
confirmed. On host runtime this is a selection safeguard, not protection from
same-user shells.

```yaml
integrations:
  version: 1
  allow:
    bigbrain: [agent_tools]
tools:
  allow:
    - bigbrain_load_memory
    - bigbrain_search_vault
    - bigbrain_read_note
    - bigbrain_drop
```

These are the complete names; there are no aliases for the removed API tools.
Allow reads without `bigbrain_drop` for a read-only agent. Drop is an outbound
content capability: an allowed agent can deliberately send material it can
access. It is not governed by a transcript-consent switch, nor is every dropped
item guaranteed to become curated memory.

The existing material-revision compare-and-set, validation freshness,
disable/remove impact confirmation, assignment, and audit lifecycle remain.
Ficus uses its private integration-material store for the **local client ID**,
not an upstream bearer token. BigBrain itself reads the private local credential
and checks it on each MCP call. Removing a Ficus connection removes its Ficus
binding, not the vault or upstream credential; revoke that credential in
BigBrain when needed.

Validation initializes MCP, lists the required public tools, and performs a
bounded read-only search. Discovery alone is insufficient: an expired upstream
connection may still list tools. Advertised tool capabilities are not proof of
write authorization; BigBrain enforces contribution scope on the actual drop.
No drop is sent as a health check. Upstream expires named connections after 30
idle days, but **Ficus's enabled-connection revalidation counts as activity** and
can keep them alive. Disable Ficus access and revoke in BigBrain when access
should end; do not depend on idle expiry while validation is active.

## Tool contract

| Ficus tool              | Upstream call  | Supported input                                                                                                                                         |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigbrain_load_memory`  | `load_memory`  | Empty object; working-set memory only                                                                                                                   |
| `bigbrain_search_vault` | `search_vault` | Exactly one of `query` or `queries` (1–8), optional `n` (1–50), `source`, inclusive `after` / `before` dates, `type` (`reference` / `entity`)           |
| `bigbrain_read_note`    | `read_note`    | `path`, optional `start`, `chars` (1–80,000), `q`, `slack` (0–20), entity `after`, `before`, `n` (1–1,000), `order`, `toc`, and linked PDF `attachment` |
| `bigbrain_drop`         | `drop`         | `title`, Markdown `body`, optional `kind` (`note`, `idea`, `finding`, `research`, `request`)                                                            |

Search retains upstream order, provenance, filters, relaxation, and
`only_agent_records`. Reads return `markdown`, provenance, links, contextual
window metadata, and slicing fields (`markdown_length`, `start`, `end`,
`truncated`) when present. Offsets are upstream character offsets, not byte or
line offsets; do not recompute them from fenced text. Read returned paths
unchanged, including JSON evidence identifiers, rather than interpreting them
as files on the Ficus host. Absolute paths, traversal, and malformed identifiers
are refused; the engine owns the actual served-set/symlink boundary.

Drop has no path, author, token, command, vault, or maintenance argument.
BigBrain stamps the named connection as an agent; Ficus records the actual
squad/agent/connection in its content-free audit. A shared connection has shared
upstream attribution. The response distinguishes a saved `id`/`path` receipt
from queued intake. Never retry a drop automatically after a timeout or lost
acknowledgment: it may already have been accepted.

Vault results remain untrusted tool data, including upstream provenance marked
`trusted`. Ficus preserves its existing tool firewall and never inserts MCP
server instructions or vault text into system instructions. Tool descriptions
encourage evidence search/citation and deliberate findings, not automatic
summaries or chat-log retention. No gardener, arbitrary MCP, resource-fetch,
sampling, or upstream integration tool is exposed.

## Process and failure boundaries

Every validation/tool invocation owns a short-lived MCP process and closes it in
`finally`. Fixed argv is `bigbrain mcp --client <id>` using the approved absolute
executable; no shell interpolation or arbitrary environment map is accepted.
`BIGBRAIN_VAULT` is always explicit. Only a restricted OS environment is inherited;
Ficus API tokens, provider keys, database URLs, and general `BIGBRAIN_*` overrides
are not forwarded. The installed upstream CLI can spawn a child, so cleanup
covers the owned process group, not just its wrapper PID. Core shutdown cancels
and awaits active sessions.

Use bounded startup/operation deadlines, raw-frame and aggregate output caps,
and a small per-process concurrency limit. Reject oversized or malformed output
rather than silently truncating evidence or retaining unlimited stderr. Logs
and audits contain identifiers, counts, timing, and fixed error codes, never
provider stdout/stderr, notes, tokens, or contribution bodies. The control plane
may display approved paths only to authorized global readers.

Actionable errors include:

| Condition                                     | What to do                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unsupported hosted/Windows/invalid-runtime    | Use macOS/Linux local/self-hosted Core with a configured runtime and co-located BigBrain; no remote bridge   |
| “BigBrain is not installed …”                 | Install and open BigBrain.app as the account that runs Ficus, then **Check again**                           |
| Command writable by others / in an agent root | Reopen BigBrain.app so it reinstalls `~/.local/bin/bigbrain`                                                 |
| Vault not found / not private                 | Open BigBrain.app to create or choose a vault; pick a private folder with `vault.yaml` outside Ficus folders |
| Existing settings file Ficus did not create   | Confirm that Ficus may manage it (its vaults are kept)                                                       |
| Connection revoked in BigBrain                | Reconnect “Local MCP configuration” in BigBrain.app's Connected Clients, then **Connect BigBrain** again     |
| BigBrain did not answer / unrecognized reply  | Open or update BigBrain.app and try again                                                                    |
| Binding changed, moved vault or command       | Run **Connect BigBrain** again; it re-pins the same Ficus connection                                         |
| Expired named connection                      | Renew it in BigBrain, then validate and enable in Ficus                                                      |
| Missing public tools / incompatible response  | Check the installed upstream revision; do not enable an HTTP fallback                                        |
| Timeout, busy, or oversized response          | Retry reads deliberately or request a smaller read/search; a timed-out drop has uncertain delivery           |

## Removal and release boundary

The unused API/token adapter, automated export capability, consent controls and
permission, execution-completion projector, export outbox/retry worker, and
`/v1/session` sender are removed together. The export-only tables and enum are
removed through a generated forward schema-cleanup migration. Historical
migration files are immutable. No legacy adapters, consent conversion, queued
payload handling, data backfill, or compatibility aliases are supplied.

There is no live cleanup or deployment inherent in this change. A later release
must replace all API/worker processes together so an old export worker is not
left running. Do not roll back to code that expects the removed export tables
or reintroduces automatic capture. Shared credential cleanup/revalidation,
OAuth/token projection, workflow outputs, other integrations, and normal Ficus
conversation persistence remain independent of this removal.

## Compatibility verification

The opt-in `upstream.smoke.test.ts` passed against the pinned revision using a
separately prepared source checkout on Linux. It exercised authenticated
validation, working-set loading, paginated reads, search, deliberate contribution,
reading its server-attributed receipt, and refusal after revocation. All vaults,
credentials and upstream state were synthetic and removed afterwards; no model
calls or real user vaults were used. The fixture denies JavaScript fetch and
Node socket connections in the CLI and its MCP child. It is not an OS network
namespace. Idle expiry is covered with a synthetic MCP response, not a 30-day
real-time smoke. The Linux smoke was rerun on 2026-10-20 through the real
Desktop-host support decision and default OS-home credential layout, without
a support override. The macOS desktop distribution was not exercised.
Static inspection at the same pin covers `desktop/src-tauri/src/lib.rs` (`shim_text`, `install_shim`,
`sidecar`), `lib/bigbrainCommand.ts`, `bin/cli.ts`, `bin/mcp.ts`,
`lib/auth.ts` and `lib/connectedClients.ts`: the app shim starts bundled Bun,
CLI dispatch preserves explicit vault selection, and named stdio uses the
OS-home private token store. This is compatibility evidence, **not** proof that
an installed macOS app passes execution, signing/quarantine or permission checks.

The Desktop-host regression uses the actual supervisor environment, separate
OS/Ficus homes, a synthetic app-style shim with spaced bundle paths, and real
Core discovery, connection persistence, validation, enablement, assignment and
all four tools against a synthetic MCP server. It checks missing executable
and private-state permissions separately, and hosted denial even with saved
intent. No real vault is used. This Linux fixture is not packaged macOS success.

One-click setup has its own synthetic Desktop-host regression: the same
app-style shim with a synthetic engine that mimics upstream `mcp config`
(create-or-reuse one `cli:config` connection, print the stdio entry). It runs
detection, the real bounded setup command, the managed bindings file, real
persistence/validation/enablement, the four tools, a repeat (idempotent, one
minted connection) and hosted refusal. Shell metacharacters in vault paths,
fixed-code failures, output caps, deadline and child cleanup are covered
separately. The pinned upstream's real `mcp config` has not been run by these
tests; it is covered by source inspection at the pin.

A macOS acceptance check still needs an installation containing this **Core
source change** (a merged PR alone does not publish/update Desktop). Open
BigBrain.app, click **Connect BigBrain on this Mac**, confirm the vault, then
assign the connection. Exercise working-set/search/read on non-sensitive test
data; an explicit drop requires separate permission and a disposable vault.
For a Desktop remote/Cloud attachment, check that the BigBrain card remains
Disabled with its reason and cannot be enabled. Do not share token contents,
private note contents or authorization headers as validation evidence.

Normal CI uses synthetic MCP and owned-process fixtures; the upstream test is
explicitly skipped unless `FICUS_BIGBRAIN_UPSTREAM_CHECKOUT` names a separately
prepared checkout at the exact pin. It never installs dependencies itself.
