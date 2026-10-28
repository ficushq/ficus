# Integration credential delivery: retire Secret Store exposure

Status: design, 2026-10-27

## Why

Squad settings → Workspace still has **Exposed Secret Store Keys**. It is left over from the global "Secrets & Keys" page, which no longer exists. Each feature now keeps its own secrets in the background, so asking people to curate store keys per squad is a dead concept. It encourages people to put arbitrary secrets in the store and to spread them into sandboxes as plaintext `.ficus/.env` exports.

The deploy integrations (Cloudflare, DigitalOcean, Netlify, Railway, Supabase, Vercel) are the main users of this path. They are not plugins. Each card stores a `DEPLOY_<X>_TOKEN` in the Secret Store and tells the admin: "Choose which squads can use this token in each squad's Environment settings. Existing exposure choices are preserved." Their skills then tell agents to ask a person to run `ficus squad-env expose-secrets`.

GitHub works the way we want. The token never sits in an environment or a file. `gh`/`git` go through `ficus integration exec`, which fetches a fresh credential from Core on every command. Disconnecting or detaching an account therefore takes effect immediately.

## Goals

- **One credential path.** Every integration credential reaches a sandbox only through `ficus integration exec`, called by wrappers placed on `PATH` for the provider's CLIs.
- **No integration token in a persistent place.** No token goes into a persistent environment (`.ficus/.env`, a process env that outlives one command) or into any file in a sandbox.
- **Deploy providers are real integration plugins.** They are assigned to squads like every other integration, they provision their CLI and skill, and they deliver auth through exec.
- **Squad, global and per-agent Secret Store exposure is removed completely**, from data through UI to prompts.
- **Secret detection on tool calls covers integration credentials and secret-looking squad Environment Variable values**, not just Secret Store entries.
- **Agent-facing text stops mentioning the Secret Store.** Credentials come from integrations. Custom secrets live in squad Environment Variables or in files in the squad or agent workspace.
- **The Secret Store is a person/operator surface only.** `ficus secret` and `/api/secrets` stay for people automating Ficus setup. Nothing agent-facing mentions them.

## Non-goals

- **Locking down `exec`.** `ficus integration exec <provider> -- <anything>` stays unrestricted. Agents need the plaintext token for complex commands (for example `exec vercel -- npm run deploy`). They are told never to read, print or log it, and detection catches leaks.
- **A credential-injecting network proxy**, where the sandbox never holds the token.
- **A per-agent secrets feature in any form.** Agents are mostly ephemeral. A file in the agent's private workspace covers the rare need.
- **Migrating exposed values anywhere.** Exposure rows are dropped and their values are not copied into Environment Variables, files or connections. The one exception is the deploy tokens' own credential (see §2).
- **Redesigning the Secret Store itself.** It stays as internal encrypted storage behind feature-owned settings.

## Anti-goals

These would count as failure even if everything else works:

- A token written into `.ficus/.env`, `.bashrc`, an agent env file or any other sandbox file by Ficus.
- A globally provisioned provider CLI run by an agent (typed directly, or reached through `PATH` from a script or Makefile) that silently runs without auth when the squad has an assigned, healthy connection.
- Stale plaintext from the old exposure exports left behind in existing `.ficus/.env` files, including VM boxes that received a pushed copy.
- Redaction that eats ordinary values. For example, a squad env value `production` must not be stripped from every tool output.

## Current state

Builder: verify these references.

- **Exposure storage.** Tables `squad_secret_exposures`, `global_secret_exposures` and `agent_secret_exposures` (`apps/core/src/db/schema.ts` around 1016/1033/1053).
- **Service and rendering.** `apps/core/src/services/squad/env.ts`:
  - `normalizeSecretKeys` (:143) and `renderSecretExports` (:168), with marker `# Generated from Ficus Secret Store allowlist`.
  - Getters/setters (:280-361) and regeneration (`regenerateEnvFileForSquad`, `regenerateEnvFilesForSecretKey`).
  - Protected integration bindings (:237-243).
  - GitHub shell functions (`githubCommandBindings`, :411-433).
- **Routes.** `routes/squad-env.ts` (`/:id/env/secrets`, `/env/global-secrets`) and `routes/agent-secrets.ts`.
- **CLI.**
  - `apps/cli/src/commands/squad-env.ts:53-156`: `secrets`, `expose-secrets`, `unexpose-secrets`, `global-secrets`, `expose-global`, `unexpose-global`.
  - `apps/cli/src/commands/agent.ts:599-650`: `agent secrets`, `expose-secrets`, `unexpose-secrets`.
  - Help text in `lib/utils/cli-help.ts`.
- **Per-agent secrets.**
  - `services/agent/secrets.ts` and `sandbox/agent-secrets-file.ts` write `<private>/.ficus/agent-secrets.env`, which `bash` sources (`tools/sandbox-tools.ts:893`).
  - Lifecycle hooks: `sandbox/ensure.ts:346`, `agents/cleanup.ts:194`, `sandbox/private-archive.ts:27`.
  - Prompt: `lib/prompts/agent-secrets-prompt.ts`, injected by the subagent, squad-manager and squad-worker runners.
- **Web.**
  - `components/squads/SquadEnvConfig.tsx:172-215` (Exposed Secret Store Keys).
  - `AgentSecretsPanel.tsx`, mounted in `AgentInfoPanel.tsx:184`.
  - `squadSettingsSearch.ts` entries.
  - API client `api/squads.ts:450-470`.
- **Deploy integrations.**
  - `services/integrations/deployment/settings.ts`: the providers, `DEPLOY_*_TOKEN` keys, and `getDeploymentAwareSecretValue`.
  - Catalog entries with `connectionMode: 'deployment'` and `assignable: false`.
  - Card copy in `apps/web/src/components/settings/IntegrationsSection.tsx:218-224`.
- **Exec.**
  - CLI: `apps/cli/src/commands/integration.ts:67-105`.
  - Route: `POST /api/squads/:id/integrations/:provider/execute-environment` (`routes/integrations.ts:850-880`, `integrations:use`).
  - Hardcoded `github`/`linear` branches in `squadIntegrationRoutesService.executionEnvironment` (`services/integrations/runtime.ts` around :832).
- **Notion.**
  - `notion/plugin.ts` installs `ntn` through the sandbox projection.
  - It projects `NOTION_API_TOKEN` and `NOTION_WORKSPACE_ID` as `protectedBindings` into `.ficus/.env` (`projection/protected-env.ts`).
- **Detection.**
  - `services/security/content-safety-registry.ts` gets exact-value matcher entries from `SecretStore.bindContentSafetyConsumer`, whole value per key, filtered by `isMatchableSecret` (min length, `NON_SECRET_KEYS`).
  - `stored-secret-tool-containment.ts` refuses tool calls that contain a stored value and audits output matches.
  - Integration connection credentials are stored as bundles behind `credentialRef`, so the access token inside a bundle is probably not matched today. Builder: confirm.
  - Squad Environment Variables (`<workspace>/.ficus/env.user`) are not in the store and are not matched.

## Design

### 1. Exec is the single credential path

- **Plugins declare how they execute.** Add an execution declaration to `IntegrationPluginV1`. It says how a connection's credential maps to environment variables for one command (for example `{ VERCEL_TOKEN: credential.token }`) and which CLI binaries get a `PATH` wrapper.
  - `executionEnvironment` resolves the declaration generically, using the same healthy-connection checks GitHub and Linear use today.
  - The hardcoded `github`/`linear` branches move into their plugins' declarations.
- **`PATH` wrappers.** For each assigned integration with an execution declaration, Ficus generates small executables in a Ficus-owned bin directory, prepended to `PATH` everywhere agents and people run commands:
  - agent `bash`
  - `squad_bash`
  - terminals
  - docker, k8s, VM and host runtimes

  Each wrapper finds the real binary further down `PATH`, skipping itself, and runs `ficus integration exec <provider> --squad <id> -- <real-binary> "$@"`. The host runtime already has this pattern for `ssh`/`scp`/`rsync` (`sandbox/host/ssh-shims.ts`, `hostBinDir`).
- **Project-local CLIs are a known, documented gap (Noah).** npm, bun and pnpm scripts put `node_modules/.bin` first on `PATH`, so a project's own `wrangler`/`vercel`, or `npx`/`bunx`, skips the wrapper. Package managers are not wrapped. The deploy skills tell agents to run project scripts as `ficus integration exec <provider> -- npm run deploy` (or the bun/pnpm equivalent).
- **Human terminals (Noah).** Terminals stay token-free and have no Ficus identity. When a wrapper runs without an agent identity, it runs the real binary unchanged and prints a one-line note to stderr that Ficus integration credentials are only available to agents. A person's own `vercel login` and similar keep working. People lose today's access to exposed deploy tokens in terminals; this is accepted.
- **Wrappers follow assignment.** Unassigning an integration or disabling its provider removes the wrapper, or the wrapper fails clearly, and exec refuses.
- **GitHub.** `gh` moves from a shell function to a `PATH` wrapper so nested invocations work. The `git` credential helper and the commit-signing configuration stay as they are, because they already work per command. Builder decides whether those stay as `.ficus/.env` git config or move into the wrapper directory, as long as no token is written.
- **Exec scrubs every provider's variables.** Today exec deletes `GH_TOKEN`/`GITHUB_TOKEN`/`GITHUB_USER` from the inherited env. It should instead delete every variable named by any plugin's execution declaration, then add only the selected provider's.
- **Exec stays unrestricted** (see Non-goals).

### 2. Deploy providers become plugins

Cloudflare, DigitalOcean, Netlify, Railway, Supabase and Vercel become `IntegrationPluginV1` plugins with a pasted API token. Linear is the template: `connectionMode: 'credential'`, `authorization.kind: 'manual'`, and `assignable: true`.

- **Assignment.** They show up as squad integration cards and use normal connections, assignment and the default account. They get multiple accounts for free.
- **Sandbox projection.**
  - Install the provider CLI, version-pinned and integrity-checked like `ntn`: `vercel`, `netlify`, `railway`, `supabase`, `wrangler`, `doctl`.
  - Attach the matching `deploy-<x>` skill.
  - Declare execution with the CLI's own token variable. Take the names from the current skills and confirm them against each CLI's docs. Expected: `VERCEL_TOKEN`, `NETLIFY_AUTH_TOKEN`, `RAILWAY_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `DIGITALOCEAN_ACCESS_TOKEN`.
  - Non-secret configuration the CLI needs, such as a Cloudflare account ID, is a connection configuration field. Builder decides whether that also travels through exec or sits in `.ficus/.env` as a non-secret binding.
- **Card copy.** The global cards drop the "exposure" copy and read like other integrations: connect an account, then assign it to squads.
- **Migration (my call).** Each existing `DEPLOY_<X>_TOKEN` value becomes a connection for that provider so nobody has to paste it again.
  - The connection is not assigned to any squad. Exposure choices are not carried over, per the no-exposure-migration decision.
  - Release notes or a one-time admin notice say that deploy integrations must now be assigned to the squads that use them.
  - The old `DEPLOY_*_TOKEN` keys, `getDeploymentAwareSecretValue` and the `connectionMode: 'deployment'` catalog path are deleted afterward.

### 3. Notion moves onto exec

- **Token.** Remove the `NOTION_API_TOKEN` protected binding. `ntn` gets a `PATH` wrapper with execution `{ NOTION_API_TOKEN: oauth access token }`.
- **Workspace ID.** `NOTION_WORKSPACE_ID` is not secret, so it may stay as a non-secret binding.
- **Leftover mechanism (my call).** If no plugin still needs secret `protectedBindings`, delete that kind of binding source rather than leaving an unused path that writes tokens to files.
- **Refresh and drift.** Token refresh and the credential-drift/projection invalidation still matter for wrapper and CLI installation. The token itself is fetched fresh on each command, so rotation no longer needs to rewrite `.env`.

### 4. Remove exposure entirely

- **Data.** Drop the three exposure tables in a migration. Stored Secret Store values are left in place.
- **Server.**
  - Delete the exposure routes, services, `renderSecretExports` and its marker handling, plus the legacy-marker code that becomes dead.
  - Delete per-agent secrets: the service, the routes, the `agent-secrets.env` writer, the `bash` sourcing and the prompt.
  - Delete `normalizeSecretKeys` once nothing uses it.
- **CLI.** Delete the `squad-env` secret subcommands, `agent secrets`/`expose-secrets`/`unexpose-secrets`, and their help and permission text.
- **Web.**
  - Delete the Exposed Secret Store Keys section, `AgentSecretsPanel`, their search-index entries and the API client functions.
  - The Workspace settings page keeps Environment Variables. Its description should say this is where to put custom secrets for the squad, and that values are visible to agents and terminals.
- **Cleanup on rollout.**
  - Regenerate every squad's `.ficus/.env` so previously rendered values disappear. On VM boxes, push the regenerated file.
  - Delete every `agent-secrets.env`. This must run automatically after deploy, not wait for the next sandbox ensure.
- **No migration of exposed values.**

### 5. Wider secret detection on tool calls

Extend the content-safety matcher and the stored-secret tool containment.

- **Integration credentials.** Every secret value inside connection credential bundles: manual tokens, OAuth access tokens and refresh tokens.
  - Entries update when a credential is stored, refreshed, rotated or deleted.
  - During a rotation, keep both old and new values for the transition window, as `publishCache` does today.
- **Squad Environment Variables.** Values in `env.user` that look like secrets get matched for that squad's tool calls.
  - Builder sets the rule. Intent: always match values of keys named like `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD` or `*_CREDENTIALS` above the minimum length.
  - For other keys, match only long, high-entropy values.
  - Never match short or ordinary words (anti-goal above).
  - If the matcher is process-wide, matching another squad's env value in this squad's output is acceptable.
- **Files.** Secrets placed in workspace files are not registered with the detector. That is out of scope.
- **Redact, don't refuse, for env values (my call).** Env values exist for agents to use, so they are only redacted from tool output. They never trigger the refuse-the-call containment, which would block ordinary work such as writing an app's `.env.local`. Integration tokens and remaining store values keep both behaviors. The refusal text (`STORED_SECRET_TOOL_REFUSAL`) stops naming the Secret Store.

### 6. Agent-facing text

Rewrite agent-facing text to the new model. Credentials come from integrations, and CLIs just work when the integration is assigned. If a CLI says it is unauthenticated, ask a person to connect or assign the integration. Use `ficus integration exec <provider> -- …` for scripts and alternate accounts. Never read, print, log or commit a token. Custom secrets are in Environment Variables or in files a person points you to.

Files to update:
- `config/agent-types/system-manager.yaml` and `assistant-worker.yaml`
- the comments in `config/roles/defaults.yaml`
- `config/skills/deploy-app/SKILL.md` and the six `deploy-<x>/SKILL.md`
- `setup-secrets/SKILL.md`
- the wikis: `deployments.md`, `secret-store.md` (drop the per-agent half), `integrations.md`, `github-integrations.md`, `settings-ui.md`
- the CLI README

### 7. `ficus secret` becomes operator-only

`ficus secret` and `/api/secrets` stay unchanged. People use them to script a Ficus setup, for example setting `FICUS_PASSWORD` or VAPID keys, and the Settings pages for the git author and the exe.dev key use the same route. Agent roles (Squad Worker, Squad Manager) already have no `secrets:*` permission, so agents cannot call it.

- **Agent-facing text.** Remove every mention from skills, agent-type prompts and agent-facing help.
- **Skills already broken.** `setup-discord`, `setup-slack` and `setup-telegram` tell agents to `ficus secret list|get|set` channel keys the route already refuses (`retiredIntegrationKey` in `routes/secrets.ts`). `setup-telegram` even reads `TELEGRAM_BOT_TOKEN` into a shell variable. `client-onboarding` and `setup-secrets` mention `ficus secret set` and `ficus secret list`.
  - Rewrite each to point at the owning Settings → Integrations card or webhook panel, and drop the token use. Core already registers the Telegram webhook (`channels/lifecycle.ts`).
  - Channel plugins get no exec declaration (my call): they are not squad-assignable, and bot tokens have no reason to reach a sandbox.
- **CLI docs.** The CLI README keeps `ficus secret` as a person/operator command. It should say that arbitrary keys are not delivered to squads.

## Testing expectations

- **Exec resolves generically.** Each plugin's execution declaration resolves the right variables only for an assigned, healthy connection, and is refused otherwise.
- **Wrappers.**
  - They are created and removed with assignment.
  - They find the real binary without recursing.
  - They work when a child process finds them on `PATH`.
  - Without an agent identity they pass through to the real binary with the stderr note.
  - Cover each runtime that already has sandbox env tests.
- **No token in sandbox files.** No integration token appears in any generated sandbox file. Add a regression test that renders `.ficus/.env` for a squad with every integration assigned and asserts that no credential value is present.
- **Rollout cleanup** removes old exposure exports and `agent-secrets.env`.
- **Detection.**
  - Integration tokens, including refreshed ones, are redacted from tool output and refuse tool input.
  - Secret-looking env values are matched; ordinary values are not.
- **Deploy migration.** It creates unassigned connections from existing tokens and deletes the old keys.

## Left to the builder

- Exact plugin execution-declaration shape and naming.
- Wrapper directory location per runtime, and the wrapper script itself.
- Pinned CLI versions and the install method for each deploy CLI.
- Whether non-secret configuration (Cloudflare account ID, Notion workspace ID) travels through exec or through `.ficus/.env`.
- The detection heuristic for env values.
- Implementation order. A sensible order:
  1. Generic execution and `PATH` wrappers (GitHub, Linear).
  2. Notion onto exec.
  3. Deploy plugins and their migration.
  4. Remove exposure and per-agent secrets, with rollout cleanup.
  5. Detection.
  6. Docs, prompts and skills.

## Decisions log

- **Noah:** exec stays unrestricted. Detection is the guard, and agents are told not to read tokens.
- **Noah:** never put integration tokens in a global env or in files. The exec wrapper is the main entry point.
- **Noah:** remove squad, global and per-agent exposure. No per-agent secrets feature.
- **Noah:** custom secrets go in Environment Variables or in files in the squad or agent workspace.
- **Noah:** don't copy exposed keys into Environment Variables, and don't migrate exposure.
- **My call:** existing deploy tokens become unassigned connections, plus an admin notice.
- **My call:** Notion's token moves to exec, and secret `protectedBindings` is deleted if unused.
- **Noah:** `ficus secret` and `/api/secrets` stay for people automating setup, and are removed from everything agent-facing.
- **Noah:** project-local CLIs bypassing the wrappers is accepted. Skills teach `exec -- npm run …`.
- **Noah:** in human terminals, wrappers pass through to the real binary with a note.
- **My call:** squad env values are redacted from output only, never refused.
- **My call:** channel plugins get no exec; their setup skills stop using tokens.
- **My call:** detection covers secret-looking squad env values, using a heuristic.
