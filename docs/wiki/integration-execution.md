# Integration command execution

Integration execution is an unrestricted, per-command credential path. This foundation migrates GitHub and Linear; Notion's protected token binding, deployment credential cards, and legacy exposure exports remain until their separate migrations. It does **not** claim that every integration is already token-free in sandbox files.

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
- The declaration is not serialized into the public catalog. Credentials never enter public declarations or wrapper files.

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

No arbitrary exposed values are migrated by this foundation. Later migrations remove Notion/deployment token projection, legacy exposure delivery, and stale files; detection and agent-facing guidance are separate changes.
