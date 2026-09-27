---
name: setup-slack
description: 'Set up Slack app integration — create the Slack app (via manifest or manually), configure OAuth, event subscriptions, and create the channel instance.'
---

# Setting Up Slack Integration

## Overview

Slack integration gives users slash commands (`/ficus status`, `/ficus ask`, etc.)
and thread-based conversations in their Slack workspace. A consultant agent
handles incoming messages.

## Who Uses This

This is primarily a **System Manager** skill — either agent can walk
the human through setup. All steps are instance-level. Squad managers do not
need this — squad linking is configured in the channel instance (Step 3).

**Before starting, check what's already configured:**

```bash
# Check if Slack secrets exist
ficus secret list | grep SLACK

# Check if channel instances exist
ficus channel list
```

If Slack is already set up, you only need to update the channel instance
to link additional squads.

## How Secrets Are Handled

- **User-provided secrets** (Signing Secret, Bot Token): Direct the human to
  enter them in **Settings → Integrations → Slack**. Do not ask them to paste secrets
  in chat. If they offer to paste a value and want you to set it, you can use
  `ficus secret set`.

## Prerequisites

- The **API URL** from the Platform URLs section in your system prompt
- The human must perform steps in the Slack API portal
- At least one squad must exist to link the channel to

> **Note:** Your system prompt includes a "Platform URLs" section with the Web UI,
> API, and webhook endpoint URLs. Use the API URL from there in the steps below.
> It is also available as the `$APP_URL` env var (web UI URL) in sandbox shells.

## Step 1: Create the Slack App

### Option A: App Manifest (Recommended)

The fastest method. Walk the human through:

1. Go to [Slack API](https://api.slack.com/apps)
2. Click **Create New App** → **From an app manifest**
3. Select the target workspace
4. Use the following YAML manifest (replace `YOUR_API_URL` with the API URL from Platform URLs):

```yaml
display_information:
  name: Ficus
  description: AI development assistant
  background_color: '#0a0a0a'
features:
  bot_user:
    display_name: Ficus
    always_online: true
  slash_commands:
    - command: /ficus
      url: https://YOUR_API_URL/api/webhooks/channels/slack
      description: Interact with Ficus AI assistant
      usage_hint: '[status|ask|help|notify|unnotify] [message]'
      should_escape: false
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - channels:join
      - groups:read
      - im:read
      - mpim:read
      - users:read
      - reactions:write
      - reactions:read
      - files:write
      - files:read
      - im:write
      - app_mentions:read
settings:
  event_subscriptions:
    request_url: https://YOUR_API_URL/api/webhooks/channels/slack
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

5. Click **Next**, review, and **Create**
6. Go to **Install App** → **Install to Workspace** and authorize

### Option B: Manual Setup

If the human prefers manual configuration:

1. Go to [Slack API](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it "Ficus" and select the workspace

**Slash Command:**

- Go to **Slash Commands** → **Create New Command**
- Command: `/ficus`
- Request URL: `<API_URL>/api/webhooks/channels/slack`
- Description: "Interact with Ficus AI assistant"

**OAuth Scopes** (under OAuth & Permissions → Bot Token Scopes):

- `commands`, `chat:write`, `chat:write.public`
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `channels:join`, `groups:read`, `im:read`, `mpim:read`
- `users:read`, `reactions:write`, `reactions:read`
- `files:write`, `files:read`, `im:write`, `app_mentions:read`

**Event Subscriptions:**

- Toggle **Enable Events** on
- Request URL: `<API_URL>/api/webhooks/channels/slack`
- Subscribe to bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`

**Install:** Go to **Install App** → **Install to Workspace**

## Step 2: Configure Secrets

Direct the human to enter the following in **Settings → Integrations → Slack**:

- `SLACK_SIGNING_SECRET` — from Basic Information → App Credentials → Signing Secret
- `SLACK_BOT_TOKEN` — from OAuth & Permissions → Bot User OAuth Token (starts with `xoxb-`)

If the human pastes a value in chat and wants you to set it, use
`ficus secret set <key> "<value>"`.

Restart the API:

```bash
ficus system restart
```

## Step 3: Create Channel Instance

Find the Slack Team ID (workspace ID). The human can find it by:

- Opening Slack in a browser — the URL looks like `https://app.slack.com/client/T0123ABCD/...`
- The Team ID is the part starting with `T` (e.g., `T0123ABCD`)

```bash
ficus channel create \
  --id "client-slack" \
  --name "Client Slack Workspace" \
  --provider slack \
  --config '{"teamId": "T0123ABCD"}' \
  --default-squad "<squad-uuid>" \
  --linked-squads "<squad-uuid>"
```

To link additional squads later:

```bash
ficus channel link-squad client-slack <squad-uuid>
```

## Step 4: Verify

Ask the human to test in their Slack workspace:

1. Type `/ficus help` in any channel — should show available commands
2. Type `/ficus status` — should show active work streams
3. Type `/ficus ask How are you?` — should get a response from the consultant
4. Reply to the bot's message in a thread — should continue the conversation

> **Slack note:** Slash commands inside threads start new conversations.
> To continue a conversation, reply to the bot's message instead.

## Optional: Channel-to-Squad Mapping

Configure specific Slack channels to route to specific squads via the Settings
UI. The human needs to provide Slack channel IDs (click channel name → About →
scroll to bottom).

## Troubleshooting

| Problem                        | Solution                                                            |
| ------------------------------ | ------------------------------------------------------------------- |
| Slash command returns error    | Verify `SLACK_SIGNING_SECRET` matches the app's signing secret      |
| Event subscriptions fail       | Check the events URL ends with `/events`, API is reachable          |
| Bot doesn't respond to threads | Verify event subscriptions are enabled and `message.*` events added |
| "dispatch_failed" in Slack     | API didn't respond in 3s — check API health and logs                |
| Bot can't post in channel      | Invite the bot to the channel, or use `chat:write.public` scope     |
