---
name: client-onboarding
description: 'End-to-end guide for onboarding a new client — configure secrets, create squads, set up integrations, and verify everything works.'
---

# Client Onboarding

## Overview

This skill guides you through setting up a new Ficus instance for a client. It
covers secrets, squads, integrations, and verification. Each section references
a dedicated skill with detailed instructions — read the relevant skill when you
reach that step.

## Prerequisites

Before starting, confirm with the human:

1. **Ficus is deployed and running** — API, worker, and web are healthy
2. **Platform URLs are available** — your system prompt includes the Web UI and API URLs (auto-configured in K8s)
3. **Database is connected** — `DATABASE_URL` and `FICUS_ENCRYPTION_KEY` are set
4. The human has access to the platforms they want to integrate (GitHub, Linear,
   Discord, Slack, Telegram)

Quick health check:

```bash
ficus system restart  # Ensure clean state
# Verify API is healthy (check from the system manager's perspective)
ficus squad list      # Should return empty or existing squads
```

## Phase 1: Secrets & Credentials

**Skill:** `setup-secrets`

Configure the essential secrets first, since everything else depends on them.

**Secret handling rules:**

- For **sensitive secrets** (API keys, tokens, passwords): direct the human to
  **the matching Settings → Integrations card or AI Providers form**. Never ask them to paste secrets in chat. If
  they volunteer a value, you can set it for them via CLI.
- For **auto-generated secrets** (webhook secrets): generate and set via CLI
  (`ficus secret set KEY "$(openssl rand -hex 32)"`). Don't read the value back —
  tell the human they can view/copy it in the Settings UI.

**Minimum required:**

1. `FICUS_PASSWORD` — authentication for the web UI and API
2. AI provider credentials (at least one) — for agent execution
3. GitHub account connection in Settings → Integrations — assign it to the squad for repository access
4. `OPENAI_API_KEY` — for memory embeddings and voice (recommended)

**Ask the human:**

- Which AI provider(s) do they want to use? (Anthropic, OpenAI, Google)
- Do they have API keys ready, or do they want to use OAuth?
- Do agents need to access private GitHub repos?
- Do they want voice input and memory search? (requires OpenAI key)
- Do they want text-to-speech? (requires Google Cloud credentials)

## Phase 2: Create Squads

**Skill:** `setup-squad`

Create the squad(s) the client needs. See the `setup-squad` skill for full
details on creating squads, setting context, and configuring integrations.

```bash
# Create an engineering squad
ficus squad create "Engineering" -p "Software development and code maintenance" -t engineering

# Create a general-purpose squad
ficus squad create "Operations" -p "General operations and support" -t general
```

Note the squad UUIDs — you'll need them for channel linking and webhook routing.

```bash
ficus squad list
```

## Phase 3: GitHub Integration

**Skill:** `setup-github-webhooks`

**Ask the human:**

- Which GitHub repositories should Ficus watch?
- Should issues be routed by labels, or should all issues go to one squad?

Steps:

1. Configure direct webhook delivery in **Settings → Integrations → GitHub → Webhook delivery** (optional when managed relay or polling is sufficient)
2. Create the webhook on each repo via `gh` CLI
3. Configure squad metadata for routing (`ficus squad set-meta ... github`)
4. Verify with `ficus webhook status github`

## Phase 4: Linear Integration (Optional)

**Skill:** `setup-linear-integration`

**Ask the human:**

- Do they use Linear for project management?
- Which Linear team(s) should route to which squad(s)?

Steps:

1. Set the webhook signing secret in Settings → Integrations → Linear → Webhook delivery (`PUT /api/integrations/providers/linear/webhook`); the `LINEAR_WEBHOOK_SECRET` env var is legacy and imported only once
2. Walk the human through creating the webhook in Linear's UI
3. Configure squad metadata for team routing
4. Verify with `ficus webhook status linear`

## Phase 5: Channel Integrations (Optional)

**Ask the human:** Which chat platforms do they want to connect?

### Discord

**Skill:** `setup-discord`

1. Walk the human through creating the Discord application and bot
2. Configure secrets (`DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`)
3. Set the interactions endpoint URL
4. Invite the bot to the server
5. Register slash commands: `ficus discord register`
6. Create the channel instance and link to squads
7. Verify with `/ficus help` in Discord

### Slack

**Skill:** `setup-slack`

1. Walk the human through creating the Slack app (manifest is fastest)
2. Configure secrets (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`)
3. Create the channel instance and link to squads
4. Verify with `/ficus help` in Slack

### Telegram

**Skill:** `setup-telegram`

1. Walk the human through creating the bot via @BotFather
2. Configure secrets and register the webhook
3. Create the channel instance and link to squads
4. Verify by messaging the bot

## Phase 6: Notifications

**Skill:** `setup-notifications`

Configure where each squad sends notifications (blocked, review, done events).

**Easiest method:** If channel bots are set up, use `/ficus notify <squad-name>`
from the target channel.

**CLI method:** Set notification metadata on each squad with the channel instance
ID and platform channel ID.

`APP_URL` is automatically configured by the infrastructure in K8s deployments,
so notification links work out of the box.

## Phase 7: Verification Checklist

Run through each integration to confirm everything works:

```bash
# Core
ficus squad list                        # Squads exist
ficus provider-auth list                # AI providers configured

# Webhooks
ficus webhook status github             # If configured
ficus webhook status linear             # If configured

# Channels
ficus channel list                      # Channel instances exist
```

**Manual tests (ask the human to perform):**

- [ ] Log into the web UI with the configured password
- [ ] Open a chat with the system manager and send a message
- [ ] (Discord) Run `/ficus help` in the Discord server
- [ ] (Slack) Run `/ficus help` in the Slack workspace
- [ ] (Telegram) Send `/help` to the bot
- [ ] (GitHub) Assign a test issue → verify the squad manager receives it
- [ ] (Linear) Assign a test issue → verify the squad manager receives it

## Quick Reference: All Secrets

| Secret                              | Required    | Purpose                                                                          |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `FICUS_PASSWORD`                    | Yes         | Web UI / API authentication                                                      |
| GitHub integration connection       | If GitHub   | Authorize an account and assign it to the squad                                  |
| GitHub integration webhook settings | Optional    | Direct webhook signature verification                                            |
| Linear integration webhook settings | If Linear   | Webhook signature verification (legacy `LINEAR_WEBHOOK_SECRET` is imported once) |
| `DISCORD_APPLICATION_ID`            | If Discord  | Discord app ID                                                                   |
| `DISCORD_PUBLIC_KEY`                | If Discord  | Discord interaction verification                                                 |
| `DISCORD_BOT_TOKEN`                 | If Discord  | Discord bot authentication                                                       |
| `SLACK_SIGNING_SECRET`              | If Slack    | Slack request verification                                                       |
| `SLACK_BOT_TOKEN`                   | If Slack    | Slack bot authentication                                                         |
| `TELEGRAM_BOT_TOKEN`                | If Telegram | Telegram bot authentication                                                      |
| `TELEGRAM_WEBHOOK_SECRET`           | If Telegram | Telegram webhook verification                                                    |
| `TELEGRAM_BOT_ID`                   | If Telegram | Telegram bot username                                                            |
| `OPENAI_API_KEY`                    | Recommended | Embeddings, voice, memory                                                        |
| `GOOGLE_APPLICATION_CREDENTIALS`    | Optional    | Text-to-speech                                                                   |
| `APP_URL`                           | Auto        | Set by infrastructure (K8s ConfigMap)                                            |
| `VAPID_SUBJECT`                     | For iOS     | Push notification sender identity                                                |
