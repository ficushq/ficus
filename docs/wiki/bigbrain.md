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
  connection validation. Both must see the same approved executable, vault,
  credential state and Ficus home under the same service account/filesystem
  namespace. Split API/worker hosts are not supported.
- A Desktop app **attached to a remote instance**, browser, mobile app or CLI
  selects bindings on the connected **Core host**, not paths on the client.
  Desktop attached to Ficus Cloud cannot reach BigBrain on your Mac. Self-hosted
  remote **agent** execution (`vm`/`k8s`) remains supported when BigBrain is local
  to Core; remote **vault** execution, remote mounts and SSH bridges are not.
- Hosted/platform-managed Core, Windows, and missing/unknown agent runtimes are
  unsupported. BigBrain stays under **Disabled**, with a visible reason, even
  when an old enabled flag is saved. Enable attempts are refused server-side;
  saved settings/connections are retained. Missing local declarations or credentials
  on an eligible host mean **setup required**, not an unsupported deployment.
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

## Operator setup on the Core host

1. Install BigBrain yourself using its reviewed upstream instructions. Select an
   existing vault and provision a **dedicated named agent connection** for Ficus
   through BigBrain. Use the same account that runs Core. A named connection is
   capable of reading the whole served vault and contributing evidence; it is
   not a per-folder permission.
2. Request the stdio configuration explicitly, not the desktop's HTTP setup:

   ```sh
   BIGBRAIN_VAULT=/absolute/path/to/vault /absolute/path/to/bigbrain mcp config
   ```

   This is an **operator action**, not a Ficus validation command: without
   `--client`, upstream may create its generic local connection. To inspect an
   already provisioned named connection without selecting another one:

   ```sh
   BIGBRAIN_VAULT=/absolute/path/to/vault /absolute/path/to/bigbrain mcp config --client 1234abcd
   ```

   Record the `--client` ID and exact vault/executable selection. Do not paste
   HTTP authorization headers, a bearer token, or an arbitrary MCP command into
   Ficus. An upstream source-checkout launch can be installed as its supported
   `bigbrain` command first; Ficus accepts no user-supplied argument list.

3. As the host operator, create `bigbrain-bindings.json` inside the **connected
   Core's configured `HOME_DIR`**. Desktop-managed local installs default to
   `~/.ficus/desktop` (or the local data directory selected in Desktop); CLI
   self-hosted installs normally use `~/.ficus`. An existing CLI installation
   opened in Desktop keeps that installation's `HOME_DIR`. Do not put the file
   in an unrelated installation's home. Protect the directory from other users;
   the file must be a regular non-symlink file owned by the
   service account or root, with no group/world permissions. Ficus only reads
   this file: no web/API/agent endpoint can edit it.

   ```json
   {
     "version": 1,
     "bindings": [
       {
         "id": "personal",
         "label": "Personal vault",
         "vaultPath": "/srv/bigbrain/personal",
         "executablePath": "/opt/bigbrain/bin/bigbrain",
         "clientId": "1234abcd"
       }
     ]
   }
   ```

   Those paths are examples, not discovery defaults. An optional
   `tokenStorePath` can select an existing upstream `BIGBRAIN_TOKENS` store when
   the operator's upstream configuration uses it. Otherwise BigBrain resolves
   its normal credential store under the service account's home. Ficus checks state metadata and permissions, but never
   parses or copies that store or its sibling `.clients` files. Provisioning
   and execution must use the same choice.

   Set the declaration's file mode explicitly after saving:

   ```sh
   # Use the local data directory selected in Desktop, not blindly the CLI home.
   FICUS_HOME="$HOME/.ficus/desktop"
   chmod 600 "$FICUS_HOME/bigbrain-bindings.json"
   ```

   **macOS:** BigBrain.app installs `~/.local/bin/bigbrain` when launched. At the
   pinned upstream revision this is a `/bin/sh` shim that quotes the bundled
   Bun and engine paths and forwards `"$@"`; it is not the BigBrain GUI binary.
   Use its absolute `/Users/you/.local/bin/bigbrain` path as `executablePath`.
   Spaces in paths are supported. Source installs can use upstream's symlink
   to `bin/cli.ts`; Core's private launch PATH includes Core's Bun directory,
   not an arbitrary login-shell PATH. It does not require Homebrew or global Bun
   for the app shim, which names its own Bun explicitly. Launch BigBrain.app
   again if it moved so upstream can refresh its shim, and revalidate.

   `HOME_DIR` is **not OS `HOME`**. BigBrain's default private credential files
   remain under the Core service user's OS home:
   `~/.config/bigbrain/tokens/<sha256(canonical-vault-path)[0:12]>.json` and
   `<store>.clients/<clientId>.json`. Both must be regular private files (mode
   `0600`); their ancestors must not be group/world writable. Do not copy tokens
   into Desktop's Ficus home or paste them into Ficus. API and worker preserve
   OS `HOME` for the child process; general inherited `BIGBRAIN_*` variables,
   including `BIGBRAIN_TOKENS`, are ignored. If upstream provisioning used a
   nondefault token store, select the **same existing store** explicitly with
   `tokenStorePath` in the host declaration. Missing state is a setup error;
   Ficus never mints credentials.

   Use canonical absolute paths (no `~` or environment expansion in JSON).
   BigBrain's installed executable may itself be
   a symlink; its resolved target is pinned at connection creation. The vault
   must contain a regular `vault.yaml`. All declaration and executable locations
   must be outside agent-writable workspace roots. Validation never recursively
   searches disks, follows an implicit default-vault pointer, installs software,
   runs `init`, or creates/renews a BigBrain credential.

4. In **Settings → Integrations → BigBrain**, enable the provider and select the
   declared local vault. The selection shows its host path and executable for
   review. **Create and validate** creates a disabled pooled Ficus connection;
   enable it after validation, then assign it in squad integration settings.
   Only global integration readers can see local binding/configuration details.
   Squad selectors retain their existing redacted connection summaries.

   Equivalent CLI selection (no bearer credential or local shell execution):

   ```sh
   ficus integration local-bindings bigbrain
   ficus integration create bigbrain --local-binding personal --display-name 'Personal vault'
   ficus integration enable "$CONNECTION_ID"
   ficus integration assign bigbrain --squad "$SQUAD_ID" --connection "$CONNECTION_ID"
   ```

A selected connection pins the resolved declaration. Changing a declaration's
vault, executable target, credential-store selection, or client ID invalidates
that binding for existing pooled connections; it never retargets their squads.
Create a new pooled connection and explicitly select it when changing identity.
Do not use this mechanism to migrate old API connections: the unused old
connector has no compatibility or migration path.

## Permissions and connection lifecycle

Global provider enablement, the enabled pooled connection, squad selection,
agent-type capability, and explicit tool allowance must all permit access.
Existing instance-scoped `integrations:read:bigbrain` /
`integrations:write:bigbrain` permissions govern the pool. Squad-scoped grants
cannot reveal host paths or edit host declarations. In isolated runtimes the
host declaration is an
additional OS-operator authorization boundary; in trusted host mode it is an
operator-selection safeguard, not protection from same-user shells. Integration
write permission alone cannot make Core run an uploaded executable or choose an undeclared vault.

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

| Condition                                                      | What to do                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Unsupported hosted/Windows/invalid-runtime or split-host setup | Use macOS/Linux local/self-hosted Core with a configured runtime and co-located BigBrain; no remote bridge |
| No host declarations                                           | Configure `bigbrain-bindings.json` in the connected Core HOME_DIR (Desktop local data directory)           |
| Missing/moved vault or executable                              | Restore the exact path or create an explicitly selected new binding; no default-vault fallback             |
| Binding changed                                                | Review the host declaration and explicitly create/select the new connection                                |
| Revoked/unavailable local credential                           | Provision a named connection in BigBrain, then select it explicitly                                        |
| Expired named connection                                       | Renew it in BigBrain, validate, and enable in Ficus                                                        |
| Missing public tools / incompatible response                   | Check the installed upstream revision; do not enable an HTTP fallback                                      |
| Timeout, busy, or oversized response                           | Retry reads deliberately or request a smaller read/search; a timed-out drop has uncertain delivery         |

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

A macOS acceptance check still needs an installation containing this **Core
source fix** (a merged PR alone does not publish/update Desktop). Confirm the
selected local data directory and same-account BigBrain shim, provision/select
a named local connection as described above, then list bindings, create/validate,
enable and assign it. Exercise working-set/search/read on non-sensitive test
data; an explicit drop requires separate permission and a disposable vault.
For a Desktop remote/Cloud attachment, check that the BigBrain card remains
Disabled with its reason and cannot be enabled. Do not share token contents,
private note contents or authorization headers as validation evidence.

Normal CI uses synthetic MCP and owned-process fixtures; the upstream test is
explicitly skipped unless `FICUS_BIGBRAIN_UPSTREAM_CHECKOUT` names a separately
prepared checkout at the exact pin. It never installs dependencies itself.
