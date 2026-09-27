---
name: setup-discord
description: 'Set up Discord bot integration — create the Discord application, configure the bot, register slash commands, and create the channel instance.'
---

# Setting Up Discord Integration

## Overview

Discord integration gives users slash commands (`/ficus status`, `/ficus ask`, etc.)
in their Discord server. A consultant agent handles incoming messages, answers
questions, and forwards action requests to squad managers.

## Who Uses This

This is primarily a **System Manager** skill — either agent can walk
the human through setup. All steps are instance-level. Squad managers do not
need this — squad linking is configured in the channel instance (Step 7).

**Before starting, check what's already configured:**

```bash
# Check if Discord secrets exist
ficus secret list | grep DISCORD

# Check if channel instances exist
ficus channel list

# Check webhook status
ficus webhook status discord
```

If Discord is already set up, you only need to update the channel instance
to link additional squads.

## How Secrets Are Handled

- **User-provided secrets** (Application ID, Public Key, Bot Token, Guild ID):
  Direct the human to enter them in **Settings → Integrations → Discord**. Do not ask
  them to paste secrets in chat. If they offer to paste a value and want you
  to set it, you can use `ficus secret set`.

## Prerequisites

- The **API URL** from the Platform URLs section in your system prompt
- The human must perform steps in the Discord Developer Portal
- At least one squad must exist to link the channel to

> **Note:** Your system prompt includes a "Platform URLs" section with the Web UI,
> API, and webhook endpoint URLs. Use the API URL from there in the steps below.
> It is also available as the `$APP_URL` env var (web UI URL) in sandbox shells.

## Step 1: Create Discord Application

**Walk the human through these steps in the [Discord Developer Portal](https://discord.com/developers/applications):**

1. Click **New Application** and name it (e.g., "Ficus")
2. Go to **General Information** and copy:
   - **Application ID** → needed for `DISCORD_APPLICATION_ID`
   - **Public Key** → needed for `DISCORD_PUBLIC_KEY`

## Step 2: Create the Bot

**Still in the Discord Developer Portal:**

1. Go to the **Bot** section
2. Click **Reset Token** and copy the token → needed for `DISCORD_BOT_TOKEN`
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** — required for reading thread replies

## Step 3: Configure Secrets

Direct the human to enter the following in **Settings → Integrations → Discord**:

- `DISCORD_APPLICATION_ID` — the Application ID from Step 1
- `DISCORD_PUBLIC_KEY` — the Public Key from Step 1
- `DISCORD_BOT_TOKEN` — the Bot Token from Step 2
- `DISCORD_GUILD_ID` (optional) — for faster command updates during development

If the human pastes a value in chat and wants you to set it, use
`ficus secret set <key> "<value>"`.

Restart the API to pick up the new secrets:

```bash
ficus system restart
```

## Step 4: Configure Interactions Endpoint

**Walk the human through:**

1. In the Discord Developer Portal, go to **General Information**
2. Set **Interactions Endpoint URL** to the webhook endpoint from your Platform
   URLs, e.g.: `<API_URL>/api/webhooks/channels/discord`
3. Discord will verify the endpoint using the public key — it should succeed
   if the secrets are configured correctly and the API is running

## Step 5: Invite Bot to Server

**Walk the human through:**

1. In the Discord Developer Portal, go to **OAuth2 → URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select bot permissions:
   - Send Messages
   - Use Slash Commands
   - Send Messages in Threads
   - Create Public Threads
4. Copy the generated URL and open it in a browser
5. Select the target server and authorize

## Step 6: Register Slash Commands

```bash
ficus discord register
```

> **Note:** Global commands may take up to 1 hour to propagate on Discord's side.
> If `DISCORD_GUILD_ID` is set, guild-specific commands are registered instead
> (instant updates — useful during setup and testing).

Check registration status:

```bash
ficus discord status
```

If there are duplicate commands:

```bash
ficus discord clear --scope global
ficus discord register
```

## Step 7: Create Channel Instance

Get the Discord guild (server) ID. The human can find it by:

- Right-clicking the server name in Discord → Copy Server ID
  (requires Developer Mode: User Settings → Advanced → Developer Mode)

Create the channel instance:

```bash
ficus channel create \
  --id "client-discord" \
  --name "Client Discord Server" \
  --provider discord \
  --config '{"guildId": "GUILD_ID_HERE"}' \
  --default-squad "<squad-uuid>" \
  --linked-squads "<squad-uuid>"
```

To link additional squads later:

```bash
ficus channel link-squad client-discord <squad-uuid>

# Or link all squads (wildcard)
ficus channel link-squad client-discord "*"
```

## Step 8: Verify

```bash
# Check webhook endpoint
ficus webhook status discord
```

Ask the human to test in their Discord server:

1. Type `/ficus help` — should show available commands and linked squads
2. Type `/ficus status` — should show active work streams
3. Type `/ficus ask How are you?` — should get a response from the consultant

## Optional: Channel-to-Squad Mapping

For servers with multiple channels that should route to different squads,
configure the `channelSquadMap` in the channel instance. The human needs to
provide Discord channel IDs (right-click channel → Copy Channel ID).

This can be configured via the Settings UI under the channel instance settings.

## Troubleshooting

| Problem                       | Solution                                                         |
| ----------------------------- | ---------------------------------------------------------------- |
| Interactions endpoint fails   | Verify `DISCORD_PUBLIC_KEY` matches, API is reachable            |
| Commands not appearing        | Wait up to 1 hour for global commands, or set `DISCORD_GUILD_ID` |
| Bot doesn't respond           | Check `DISCORD_BOT_TOKEN` is valid, bot is invited to server     |
| "Thinking..." never goes away | Check API logs for errors in consultant execution                |
| Thread replies not working    | Verify **Message Content Intent** is enabled in bot settings     |
