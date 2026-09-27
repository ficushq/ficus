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
