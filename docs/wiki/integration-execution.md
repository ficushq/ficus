# Integration command execution

Integration execution is an unrestricted, per-command credential path. GitHub, Linear, Notion and the six deployment providers use it. Legacy squad/global/per-agent key delivery is retired; see the [automatic cleanup upgrade notes](../upgrade/secret-exposure-retirement.md) for durable pending/failed runtime cleanup and retry behavior.

## Plugin contract

`IntegrationPluginV1.execution` is optional and server-only:

```ts
execution: {
  binaries: ['example'],
  environment: {
    EXAMPLE_TOKEN: ({ credential }) => credential.token,
    EXAMPLE_ACCOUNT: ({ configuration }) => configuration.accountId,
  },
}
```

- `environment` declares static, valid environment-variable names and synchronous resolvers using the plugin's parsed configuration and credential. Both secret and non-secret command configuration may be mapped. Never use this declaration as a persistent sandbox binding.
- `binaries` names globally installed executables, not paths. Names must be unique across assigned providers; conflicts fail projection clearly. Do not wrap package managers or `ficus` itself. CLI installation remains the plugin's existing sandbox projection responsibility.
- GitHub declares `gh` and `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_USER`. Linear declares `LINEAR_API_KEY` and no binary: Ficus does not provision a Linear CLI. It can still authenticate arbitrary scripts through exec. Channel plugins have no execution declaration.
- Notion declares `ntn` and `NOTION_API_TOKEN`, resolved from the current OAuth access token on every invocation, including nested commands. `NOTION_WORKSPACE_ID` remains a **nonsecret configuration** binding in `.ficus/.env` for compatibility with workspace-aware CLI usage. Protected bindings accept configuration fields only; the unused OAuth-token source and projection credential reader have been removed.
- The declaration is not serialized into the public catalog. Credentials never enter public declarations or wrapper files.

Execution callbacks keep their precise configuration/credential types. OAuth-only
views and refresh services consume authorization capabilities, not command
execution callbacks. A manual-to-managed OAuth view drops the manual execution
declaration when replacing its credential codec; it must not advertise that a
manual-token resolver accepts an OAuth bundle. Execution uses the original plugin
registry, not that OAuth-flow-only view.

`IntegrationExecutionService` resolves the live squad default, or an explicitly named **attached** connection. The assigned repository reconciles squad enable/default choices and checks the effective global provider switch. Delivery additionally requires matching provider and adapter version, an enabled/authenticated/healthy connection, matching material/validated revisions, and unexpired validation. OAuth delivery also checks the active client authority and token expiry. Invalid or absent material refuses delivery. The credential store is refreshed on each invocation; no credential is cached in a wrapper.

## HTTP and CLI contract

The existing permission-guarded endpoint remains:

```text
POST /api/squads/:squadId/integrations/:provider/execute-environment
{
  "connectionId": "optional-explicit-attached-account-uuid",
  "inheritedSelection": { "providerKey": "github", "squadId": "canonical-full-uuid", "connectionId": "attached-account-uuid" }
}
```

A successful, `Cache-Control: no-store` response is:

```ts
{
  environment: Record<string, string>, // selected provider only
  scrubVariables: string[],           // names from ALL plugin execution declarations
  selection: { providerKey: string, squadId: string, connectionId: string } | null,
}
```

The CLI copies the inherited environment, deletes every `scrubVariables` entry (including unassigned/disabled providers), then adds only `environment`. Unrelated inherited variables remain. Update Core and the CLI together: the new CLI refuses a response lacking the scrub or canonical selection contract rather than retaining cross-provider credentials or silently changing accounts.

```sh
ficus integration exec github --squad <squad-id> -- gh pr list
ficus integration exec github --squad <squad-id> --connection <attached-account-id> -- gh pr list
ficus integration exec <provider> --squad <squad-id> -- npm run deploy
```

### Explicit accounts and nested wrappers

`--connection` selects an attached account for the whole same-provider/squad
command subtree, including a direct `-- gh …` or a script that later finds `gh`
on PATH. The CLI carries **token-free intent**, not authorization or cached
credentials, in the transient child-only `FICUS_INTEGRATION_EXEC_SELECTION`
environment variable: JSON `{ providerKey, squadId, connectionId }`.

Every nested wrapper still enters normal exec and calls Core again with that
connection ID. A revoked, detached, unhealthy or unavailable explicit account
fails; it never silently falls back to the default. A missing/unhealthy default
does not block a healthy explicit account. An explicit inner `--connection`
overrides inherited intent. Supported short squad IDs are resolved uniquely and
authorized by Core's existing squad guard. The CLI sends inherited intent as
`inheritedSelection`; **Core**, not the CLI, compares it against that canonical
squad ID and provider, after authorization. It returns `selection` with full,
canonical IDs on successful explicit/inherited selection, or `null` for the
default. The CLI stores only this authoritative response, never the raw `--squad`
argument. Equivalent nested short/full forms therefore retain the same account.
Ambiguous/unknown squad prefixes refuse before credentials are resolved; context
itself must use a full UUID, never unchecked prefix matching. An unrelated/default
exec clears prior intent from its child environment. Malformed context fails
closed without echoing its contents.
This metadata is never written into wrappers, bashrc or persistent environments,
and does not replace all-provider credential scrubbing. Like `--connection`, it
cannot grant access to an unattached or unauthorized account.

Exec does not restrict the command or its descendants. Credentials exist only in that command's transient process environment. Never read, print, log, persist, or commit a credential. SIGINT/SIGTERM are forwarded; argv, standard streams and exit status are preserved.

## Executable wrappers and lifecycle

Squad environment regeneration reconciles token-free executable scripts in the Ficus-owned `.ficus/integration-bin` directory. It reads assignment metadata, not credentials. Declared binaries are projected for enabled assigned providers even during a temporary health/validation lapse; live exec refuses unusable access instead of silently running unauthenticated.

Each wrapper finds the executable on PATH, skips itself (including symlink/duplicate aliases) and other generated wrapper copies, then runs:

```text
ficus integration exec <provider> --squad <squad-id> -- <real-binary> <original-argv...>
```

The wrapper retains PATH, so non-shell children also find wrappers and obtain fresh credentials. Header inspection is bounded to 80 bytes; `head` is resolved from PATH or standard `/usr/bin/head` / `/bin/head` locations. Missing inspection tooling or a missing real binary fails clearly rather than recursing. Shell-local implementation names use the `__ficus_wrapper_` prefix.

With no injected `FICUS_TOKEN` identity, a wrapper never calls Ficus. It prints one stderr line explaining that integration credentials are only available to agents, then execs the real binary unchanged. A person's own CLI login remains usable. Terminals never receive an agent identity.

Unassignment or provider disable removes projected wrappers during regeneration. VM copies are pruned by the managed asset manifest on synchronization. A stale wrapper still uses live authorization and refuses detached/disabled access immediately. Removing only a default account preserves other attached accounts and their explicit selection; it does not invent a replacement default.

## Runtime paths and entrypoints

Managed wrapper PATH is prepended **after** environment/toolchain activation, for agent `bash`, `squad_bash`, and interactive terminals:

| Runtime    | Wrapper location / projection                                                                                                                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker     | `<workspace-mount>/.ficus/integration-bin`, through the existing squad workspace mount; spawn hook and terminal bashrc prepend it.                                                                                                                                                                        |
| Kubernetes | Same existing workspace mount; sandbox-server command preamble and terminal bashrc prepend it.                                                                                                                                                                                                            |
| VM         | Each box's own `<box-home>/workspace/.ficus/integration-bin`; the `integration-wrappers` asset pushes files with mode `0755` and records exact files for pruning. Member boxes use this copy even when their working root is `<box-home>/.private`. Both command and terminal preambles select this path. |
| Host       | `<HOME_DIR>/workspaces/squads/<squad-id>/.ficus/integration-bin`, in Ficus storage, **not** a workspace override repository. Command environments/preambles and the managed terminal bootstrap prepend it.                                                                                                |

Host web terminals use managed Bash (an explicit product decision): `/etc/profile`, then the first readable `~/.bash_profile`, `~/.bash_login`, or `~/.profile` are sourced before managed paths are restored. The token-free bootstrap lives under `<HOME_DIR>/host/terminals/`; it does not edit the operator's profiles, source squad credential exports, or grant an agent identity. Other runtimes retain their existing terminal startup model.

## Git and project-local commands

Git's credential helper and commit-signing configuration live in
`.ficus/integration-bin/.git-config` as **token-free instructions**, not credentials.
The helper enters exec for each credential request; commit signing calls Core per
command. This file travels with the wrapper asset and is sourced after activation
only for commands with an injected agent identity. This location matters on VM
member boxes: their command root is `~/.private`, while their squad `.env` copy is
under `~/workspace`. Keeping the instructions with wrappers avoids relying on that
separate env sourcing path or widening legacy credential delivery. Human shells do
not receive these Git overrides. Existing Git configuration precedence and signing
behavior are preserved. The old `gh` shell function is removed (and explicitly
unset by the preamble); only `git` remains a shell binding. `gh` now uses an
executable PATH wrapper, including from child processes.

Project-local CLIs are an accepted gap: npm/bun/pnpm scripts may put `node_modules/.bin` before the managed directory, and `npx`/`bunx` may bypass it. Package managers are not wrapped. Run such scripts explicitly through `ficus integration exec <provider> --squad <squad-id> -- npm run deploy` (or the bun/pnpm equivalent).

Notion refresh, revocation, credential-drift detection and projection invalidation remain active. Rotated credentials work immediately without rewriting `.env` or wrappers or reinstalling the CLI. Reconciliation may still regenerate token-free metadata and verify installation readiness; rotation does not change generated file contents. Invalid/revoked or detached connections refuse even through a stale wrapper.

No arbitrary exposed values are migrated. See the cleanup, detection and managed-guidance acceptance below.

## Detection boundaries

Integration credential bundles register their secret leaves, including manual
credentials, OAuth access/refresh tokens and channel signing material, rather
than matching the serialized JSON bundle or public metadata. Storage, refresh,
rotation, reload and deletion update exact-value matching. Old/new values coexist
across cache publication. Integration material and remaining operator values
redact tool output and refuse tool input; refusal text does not name an internal
storage system. Exec itself remains unrestricted.

Squad `.ficus/env.user` is an output-only source. Literal values of keys ending in
`TOKEN`, `KEY`, `SECRET`, `PASSWORD` or `CREDENTIALS` (case-insensitive, underscore
boundary) match at 12 characters. Other keys require at least 32 characters, two
character classes and Shannon entropy of at least 4 bits per character; whitespace,
URLs and filesystem paths are excluded from that fallback. `production` and other
short ordinary values do not match. Parsing does not execute shell substitutions,
source files or follow symlinks. Dynamic expressions cannot be inferred. Changes
are rechecked at redaction boundaries with metadata-based parse caching. Matching
is process-wide, so another squad's output may also be redacted. These values
**never refuse tool input**, including ordinary app environment-file writes.
Human-directed workspace files are not registered/scanned by this source.

## Managed guidance updates

Bundled guidance is in `config/agent-types`, `config/agent-types/shared`,
`config/roles/defaults.yaml` and `config/skills/*/SKILL.md` (including support
Markdown). `services/config-sync/index.ts` runs `syncAllConfig()` at API startup;
`SkillSync` and `AgentTypeSync` refresh templates and invalidate entity caches.
The worker consumes the database definitions. See [configuration sync](config-sync.md)
for authoritative override/revert semantics.

- Non-overridden fields receive the bundled rewrite. Custom records and
  overridden `content`, `supportFiles` or `systemPrompt` fields are preserved,
  not destructively replaced. Administrators should compare affected skill/type
  templates and deliberately apply credential-guidance changes to custom fields.
  A full revert also removes unrelated customizations; do not bulk-revert them.
- `services/agent/skill-materializer.ts` writes enabled database skills to managed
  materialized/per-sandbox directories; runner `resolveSkillRefs` combines agent
  type, squad and integration skill references before materialization. Changed
  content is rewritten and stale managed support files are pruned there. VM
  `file-sync.ts` transports skill assets. Existing sessions/copies are not proof
  that a new seed has been consumed; verify after the normal refresh/reconnect.
- `lib/utils/cli-help.ts` generates cached agent references from the built CLI,
  omitting operator credential commands even under broad user permissions. Ship
  the matching CLI with Core; operator `ficus --help` remains unchanged. CLI
  install bundles also copy `external/skills`; those are a separate upstream
  source, not the managed `config/skills` seed.
- This rewrite changes repository seeds and documentation only, not live skills,
  runtime configuration, user overrides or existing conversations. Historical
  approved designs are immutable and excluded from the active guidance scan.

## Acceptance matrix

These focused regressions use synthetic credentials and local test resources;
passing them is evidence of shipped behavior, **not** a live fleet cleanup or
provider deployment. Paths below are relative to `apps/core/src` unless noted.
Run focused files, not the full Core suite.

| Requirement | Regression evidence |
| --- | --- |
| Generic assigned/healthy/default/alternate-account exec; expiry/authority/refusal | `services/integrations/execution.test.ts`, `deployment/execution.test.ts` under that directory |
| Inherited all-provider env scrubbing; unrestricted commands, selector defaults and nested explicit accounts | `apps/cli/src/commands/integration-exec.test.ts`, `integration-selection.process.test.ts`, `integration-squad-context.process.test.ts` (repo-relative) |
| Executable wrapper lookup without recursion, child-process PATH use, argv/status, human pass-through, assignment removal | `services/integrations/execution-wrappers.test.ts`, `execution-lifecycle.test.ts` |
| Docker agent/squad command hooks and terminal activation | `services/sandbox/docker/manager.test.ts`, `services/sandbox/bashrc.test.ts` |
| Kubernetes agent/squad preambles and terminal activation | `packages/sandbox-server/src/services/bash.test.ts` (repo-relative), `services/sandbox/bashrc.test.ts` |
| VM member/squad command and terminal paths; executable copies and pruning | Same sandbox-server/bashrc tests, `services/sandbox/vm/file-sync.test.ts` |
| Host agent/squad identity-safe shim-first PATH and managed Bash human terminal | `services/sandbox/host/env.test.ts`, `manager.test.ts`, `terminal-bootstrap.test.ts` |
| Git per-command credential helper/signing instruction remains token-free | `services/squad/github-command-bindings.test.ts` |
| Every integration assigned (GitHub, Linear, Notion, six deployment providers, nonexec/channel adversarial assignments): no credential in generated `.env`, any generated `.ficus` file, or toolchain configuration | `services/integrations/deployment/execution.test.ts` enumerates the current plugin registry and scans all generated files; `execution-lifecycle.test.ts` covers Notion rotation |
| Deploy import stored-only/env-only/stored-wins, durable per-provider marker, no overwrite after rotation, no assignments/defaults, retired lookup names | `services/integrations/deployment/migration.test.ts`; operator action notice: [deployment upgrade](../upgrade/deploy-provider-connections.md) |
| Exposure routes/tables/prompts/panels removed; custom env preserved, generated output clean immediately | `services/sandbox/exposure-retirement.test.ts`, `services/squad/env.test.ts`, `db/exposure-retirement-migration.test.ts` |
| Startup shared-mount sweep; offline VM pending/reconnect, durable restart retry, both effects acknowledged, conflicting directories/backoff/status; private/archive/restore cleanup | `services/sandbox/exposure-cleanup.test.ts`, `exposure-retirement.test.ts`, `services/machines/migration-exposure-cleanup.test.ts` |
| Integration leaf detection storage/refresh/rotation/delete and conservative cache transition | `services/secrets/store.test.ts`, `services/integrations/authorization/refresh-service.test.ts`, `services/security/content-safety-registry.test.ts` |
| Env output-only matching and ordinary-value exclusions; normal app env writes allowed, integration tool input refused | `services/security/squad-env-secret-source.test.ts`, `content-safety.test.ts`, `stored-secret-tool-containment.test.ts`, `tool-output-redaction.test.ts` |
| Active skill/prompt text, six deploy script examples, channel setup, honest legacy deploy option help, operator-only docs | `scripts/integration-credential-guidance.test.ts` (repo-relative), `lib/utils/cli-help.test.ts` |
| Seed/template updates preserve custom overrides; normal materialization refresh | `services/config-sync/skill-sync.test.ts`, `agent-type-sync.test.ts`, `services/agent/skill-materializer.test.ts` |
| Channel plugins never deliver exec credentials; Telegram webhook stays Core-owned | All-assigned regression above; `services/integrations/channels/plugins.test.ts`, `lifecycle.test.ts` |

Cleanup acceptance deliberately allows **pending** unreachable targets and
**failed** targets with a visible reason and delayed retry. No execution gate is
introduced. A target is not done until regenerated environment and retired-file
removal are acknowledged; existing processes are not stopped or scrubbed. Consult
[automatic cleanup](../upgrade/secret-exposure-retirement.md) instead of assuming
all copies are clean immediately after upgrading. Arbitrary old exposed values
are never migrated. No deployment, live cleanup or credential inspection is
part of this validation.
