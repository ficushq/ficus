---
name: setup-squad
description: 'Create and configure a squad — set purpose, link repos, configure GitHub/Linear routing, set up notifications, and connect channels.'
---

# Setting Up a Squad

## Overview

A squad is a persistent team of AI agents that works on tasks together. This
skill covers creating a squad and configuring all its integrations.

## Who Uses This

- **System Manager** — Create squads during client onboarding or
  when the human requests a new team.
- **Squad Manager** — Configure integrations for their own squad (GitHub/Linear
  routing, notifications). Skip to the relevant section.

**Before starting, check existing squads:**

```bash
ficus squad list
```

## Step 1: Create the Squad

First, check which squad presets are available:

```bash
ficus squad-preset list
```

Then create the squad:

```bash
ficus squad create "<Squad Name>" \
  -p "<Purpose description>" \
  -t <squad-preset>
```

Example:

```bash
ficus squad create "Backend Team" \
  -p "Backend API development and maintenance" \
  -t engineering
```

Note the squad UUID from the output — you'll need it for subsequent steps.

```bash
# List squads to find the ID
ficus squad list
```

## Choose how the squad works

Use the `setup-workflows` skill with the user to choose a default flow and
when to use alternatives. A team preset describes the squad's domain; it does
not require the same architect/engineer/reviewer sequence for every request.
Configure or publish flows without creating their participant agents. Existing
squads opt in explicitly; existing work streams retain their process.

## Step 2: Set Squad Context

Add context that all agents in the squad will see in their system prompts:

```bash
ficus squad update <squad-id> --context "Primary repository: https://github.com/owner/repo-name

Tech stack: TypeScript, Bun, Hono, React, PostgreSQL
Branch strategy: feature branches off main, PRs required"
```

Keep it concise — this goes into every agent's system prompt.

## Shared memory and workspace documentation

Use this section when a repo is first cloned, useful wiki/docs/runbooks are
found, or documentation is merged, moved or retired. The manager maintains
which canonical documents are searchable; workers keep their content current.
Do this autonomously during ordinary squad/repository upkeep, including an
existing squad's first relevant maintenance pass. Do not ask users to discover
paths, choose globs or run reindexing. An ambiguous data boundary or an explicit
opt-out is a reason to ask; routine indexing of appropriate squad docs is not.

### Check the actual configuration

```bash
ficus --json squad get <squad-id>
ficus squad source list <squad-id>
```

New squads enable shared memory by default; managers still select useful docs
once the squad has a canonical checkout.

Inspect `metadata.memory.enabled` and `metadata.memory.workspacePaths` in the
squad response. **Absent or false `enabled` means the memory prompt and native
memory tools are not supplied to squad agents.** The CLI can still list starter
files; their presence does not mean memory is enabled. `sync status` describes
remote vault synchronization, not whether local memory is enabled.

If `enabled` is unset, enable memory as part of this routine setup. If it is
explicitly `false`, preserve the opt-out and explain why those docs will not be
indexed; do not repeatedly ask. Do not change global embedding-provider settings,
external sync destinations, or memory grants as part of this upkeep.
For an unset setting (or a user-requested enablement):

```bash
ficus squad set-meta <squad-id> memory.enabled true
```

### Index canonical docs in place

Inspect the shared workspace and choose the actual canonical checkout, not a
guessed repo name or every agent worktree. Review the content of each selected
document before indexing; sampling a folder is not enough.
If a long-lived integration worktree is the only maintained source, allowlist
only its useful docs explicitly and move those paths when the source moves;
do not include sibling worktrees or treat draft branch docs as accepted guidance. Prefer
small allowlists for maintained README/AGENTS files, docs/wiki, architecture,
accepted decisions and runbooks. Repo docs stay authoritative; do not duplicate
them in vault notes. Indexing makes content discoverable to the squad and any
existing memory grantees, so respect its audience and sensitivity. Do not widen
grants or index secrets, credentials, sensitive personal/customer data or private dumps.

**Never index a document containing sensitive information, even if the rest is
useful.** Operational guides and runbooks may contain credential-bearing commands
or URLs, sensitive personal/customer data, or genuinely confidential business or
security information. Ordinary hostnames, paths, non-secret account/resource IDs,
notification routing, deployment commands and operational/recovery procedures are
not sensitive by themselves; keep them searchable unless their context makes them
confidential or access-enabling. Do not exclude a guide just because it is operational. A docs/wiki location, existing access grant or clean
secret-pattern scan does not establish safety. Exclude the whole document if
sensitive or uncertain; do not expose its contents in reports, logs or vault notes.
Prefer explicit reviewed file paths. Broad globs automatically admit future files,
and the watcher ingests edits automatically: re-check sensitivity before updating
indexed docs or expanding an allowlist, and exclude a file before adding sensitive
content. A separately reviewed non-sensitive guide may be indexed; do not silently
edit or delete the original to make it indexable.

If unsafe content is already indexed, exclude it and use supported workspace
reconciliation to remove the indexed document and chunks. Verify removal by path
and harmless identifiers without repeating sensitive values. Saving exclusions
alone is not proof of removal; report failures and keep the path excluded.

Watcher globs live in **`memory.workspacePaths`**, relative to the shared workspace
root (not the repository root). `ficus squad source set ... workspace_file` sets
an ingestion policy; it does **not** configure which files the watcher scans.
No source-policy rows means defaults, not that memory is necessarily disabled.

Read and merge the current include/exclude lists before setting them. The arrays
below are an example for a checkout named `my-repo`; setting them replaces the
existing arrays. Preserve existing intentional paths and exclusions. Use the
nested key so other memory settings (sync, embedding model) are preserved:

```bash
ficus squad set-meta <squad-id> memory.workspacePaths '{"include":["my-repo/README.md","my-repo/AGENTS.md","my-repo/docs/wiki/**/*.md","my-repo/docs/architecture/**/*.md"],"exclude":["**/worktrees/**","**/docs/plans/**","**/docs/drafts/**","**/docs/archive/**","**/docs/retired/**","**/.env*","**/*.secrets.*","**/*kubeconfig*","**/*.pem","**/*.key"]}'
```

The example globs assume every matched document has passed content review; use
explicit reviewed files where that cannot be assured. Choose paths that exist; do not index entire repositories or all `**/*.md` in the
workspace. Exclude generated/vendor trees, logs, evidence dumps, temporary plans,
and duplicate checkouts even when they are Markdown. Do not assume the built-in
excludes cover every secret or generated file. Explicitly disabled source policies
remain disabled; do not override them as a troubleshooting shortcut.

### Verify and maintain

The watcher configuration is reconciled when the squad sandbox is ensured.
Saving metadata alone is not proof it is active. After the next normal sandbox
ensure, request a workspace rescan and inspect its result:

```bash
ficus --json memory reindex --squad <squad-id> --source workspace_file
ficus --json squad get <squad-id>
ficus memory search "<distinctive heading from an included doc>" --squad <squad-id> --source-type workspace_file --mode keyword
```

The top-level `filesIndexed` counts vault files, so zero is expected for a
workspace-only rescan. Use `workspaceFilesScanned` for the workspace scan.
Check `workspaceFilesScanError`, the scan count, and
`metadata.memory.workspaceScanStatus` (freshness and skipped-file reasons), then
confirm a representative result from the intended path. A successful HTTP response
or `success: true` alone does not prove files were scanned. If the watcher is not
configured yet, report that state; do not restart busy agents or repeatedly reindex.
Search can lag ingestion. Default limits are 100KB per file and 1,000 files per
include pattern; narrow patterns or split oversized docs when needed.

Changes to watched local files are picked up automatically. A GitHub merge does
not update a local checkout: refresh the canonical checkout through the normal
safe repo workflow (never overwrite local changes), then verify search after a
significant docs update. Update globs when paths move or repos are retired;
preserve unrelated configuration. Treat historical docs as historical evidence,
not current instructions. Do not rewrite customized vault maps just to match the
starter template; reconcile only misleading guidance when authorized.

Before handoff/completion, workers should check whether they learned a reusable
fact. Update existing canonical docs or a focused vault note with the source,
verification date and scope. Avoid duplicates, private status notes and completion
logs. No new knowledge means no write; this is not a quota or approval gate.

## Step 3: Configure GitHub Integration (Optional)

Set routing metadata so the squad receives GitHub issue assignments:

```bash
# Route all issues from a repo
ficus squad set-meta <squad-id> github '[{"repo": "owner/repo-name"}]'

# Route only issues with specific labels
ficus squad set-meta <squad-id> github '[{"repo": "owner/repo-name", "labels": ["backend", "api"]}]'

# Multiple repos
ficus squad set-meta <squad-id> github '[{"repo": "owner/repo-a", "labels": ["backend"]}, {"repo": "owner/repo-b"}]'

# Wildcard repo routing (anchored glob-style, not regex)
ficus squad set-meta <squad-id> github '[{"repo": "owner/*"}]'
ficus squad set-meta <squad-id> github '[{"repo": "owner/*-api-*", "labels": ["backend"]}]'
ficus squad set-meta <squad-id> github '[{"repo": "*/repo-name"}]'
```

**Prerequisites:** GitHub webhooks must be set up first (see `setup-github-webhooks`
skill, Steps 1–3). Check with:

```bash
ficus webhook status github
```

For full details on PR tracking and issue metadata on work streams, see the
`setup-github-webhooks` skill (Steps 5–6).

## Step 4: Configure Linear Integration (Optional)

Set routing metadata so the squad receives Linear issue assignments:

```bash
ficus squad set-meta <squad-id> linear '[{"teamId": "team-uuid-here"}]'
```

**Prerequisites:** Linear webhooks must be set up first (see `setup-linear-integration`
skill, Steps 1–3). Check with:

```bash
ficus webhook status linear
```

For full details on issue metadata on work streams, see the
`setup-linear-integration` skill (Step 5).

## Step 5: Configure Notifications (Optional)

Set up where the squad sends notifications for blocked, review, and done events.

**Easiest method** — If a channel bot is already set up, use the slash command
from the target channel:

```
/ficus notify <squad-name>
```

**CLI method** — Set notification metadata with the channel instance ID and
platform channel ID:

```bash
# List available channel instances
ficus channel list

# Discord
ficus squad set-meta <squad-id> notifications.discord.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.discord.channelId "<discord-channel-id>"

# Slack
ficus squad set-meta <squad-id> notifications.slack.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.slack.channelId "<slack-channel-id>"

# Telegram
ficus squad set-meta <squad-id> notifications.telegram.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.telegram.channelId "<telegram-chat-id>"
```

For more details, see the `setup-notifications` skill.

## Step 6: Link to Channels (Optional)

If channel instances exist (Discord, Slack, Telegram), link the squad so
users can interact with it via slash commands:

```bash
# Check existing channel instances
ficus channel list

# Link this squad to a channel instance
ficus channel link-squad <channel-id> <squad-id>

# Or link all squads (wildcard)
ficus channel link-squad <channel-id> "*"

# Remove a squad from a channel
ficus channel unlink-squad <channel-id> <squad-id>
```

You can also set linked squads during channel creation or update:

```bash
# During create
ficus channel create --id my-discord --name "My Server" --provider discord \
  --config '{"guildId": "..."}' --linked-squads "<squad-id-1>,<squad-id-2>"

# During update (replaces all linked squads)
ficus channel update <channel-id> --linked-squads "<squad-id-1>,<squad-id-2>"

# Link all squads via wildcard
ficus channel update <channel-id> --linked-squads "*"
```

## Step 7: Verify

```bash
# Check squad config
ficus squad get <squad-id>

# Verify agents are ready (only the manager and any default agents should exist)
ficus squad agents <squad-id>

# Check metadata (github, linear, notifications)
ficus --json squad get <squad-id> | jq .metadata
```

## Quick Reference: Squad Metadata Keys

| Key                                 | Purpose                                |
| ----------------------------------- | -------------------------------------- |
| `github`                            | GitHub repo/label routing (JSON array) |
| `linear`                            | Linear team routing (JSON array)       |
| `notifications.discord.instanceId`  | Discord channel instance ID            |
| `notifications.discord.channelId`   | Discord channel ID for notifications   |
| `notifications.slack.instanceId`    | Slack channel instance ID              |
| `notifications.slack.channelId`     | Slack channel ID for notifications     |
| `notifications.telegram.instanceId` | Telegram channel instance ID           |
| `notifications.telegram.channelId`  | Telegram chat ID for notifications     |
