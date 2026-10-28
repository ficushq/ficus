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
# Check if channel instances exist
ficus channel list

# Check webhook status
ficus webhook status discord
```

If Discord is already set up, you only need to update the channel instance
to link additional squads.

## Credential handling

Have the human enter credentials only in **Settings → Integrations → Discord**.
Never ask for tokens in chat. Never read, print, log or commit credentials, even if
volunteered. Saved credentials remain hidden; replace them in the owning card to
rotate. Enable and validate the connection there. No channel token belongs in a
sandbox or integration exec command; channel plugins have no command execution.
Slash commands work through the gateway; HTTP delivery is optional. If using HTTP,
copy the Interactions Endpoint URL from that panel, including any public base path;
never infer an API hostname from `APP_URL`. Saved changes reconcile without a manual restart.

## Prerequisites

- The human must perform steps in the Discord Developer Portal
- At least one squad must exist to link the channel to

No public webhook URL is needed for the default gateway delivery.

## Step 1: Create Discord Application

**Walk the human through these steps in the [Discord Developer Portal](https://discord.com/developers/applications):**

1. Click **New Application** and name it (e.g., "Ficus")
2. Continue to the Bot section. Ficus discovers the Application ID and public key
   during connection setup; do not ask the human to copy or enter either value.

## Step 2: Create the Bot

**Still in the Discord Developer Portal:**

1. Go to the **Bot** section
2. Click **Reset Token** and keep the token private for the Ficus Bot token form.
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** — required for reading thread replies

## Step 3: Configure the Integration

Have the human open **Settings → Integrations → Discord** and enter only the
**Bot token**. Bot token is the only credential field. Save, validate and enable
the connection. Ficus discovers the Application ID and public key through Discord;
the public key stays hidden. No manual restart is required.

After inviting the bot, the card discovers its servers. If there is more than one,
choose **Server the bot answers in** under **Default squad**. This is a separate
routing selector, not a credential field. The selected identity appears as
**Server ID**; a single discovered server can be selected automatically. If no
server is available, invite the bot first. Server-specific command registration
follows the selected server; without one, registration is global.

## Step 4: Optional HTTP Interactions Endpoint

HTTP delivery is optional: Ficus connects the gateway and slash commands work
through it without a public endpoint. For HTTP delivery only, copy the
**Interactions Endpoint URL** from **Settings → Integrations → Discord** into
**General Information → Interactions Endpoint URL** in the Developer Portal.
Discord verifies it with the discovered public key; no key input or token-bearing
shell command is needed.

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

## Step 6: Verify Slash Commands

Core registers slash commands when the usable connection revision changes.
To explicitly retry registration if needed:

```bash
ficus discord register
```

> **Note:** Global commands may take up to 1 hour to propagate on Discord's side.
> If a server is selected in the integration card, guild-specific commands are registered instead
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
| Interactions endpoint fails   | For optional HTTP delivery, check connection status and endpoint reachability; do not retrieve keys            |
| Commands not appearing        | Wait for global command propagation; inspect the separate server selection and registration status |
| Bot doesn't respond           | Check validation/gateway status, bot invitation and server routing; replace a rejected token only in the card     |
| "Thinking..." never goes away | Check API logs for errors in consultant execution                |
| Thread replies not working    | Verify **Message Content Intent** is enabled in bot settings     |
