---
name: setup-discord
description: 'Set up Discord bot integration — create the Discord application, configure the bot, register slash commands, and create the channel instance.'
---

# Setting Up Discord Integration

Discord integration gives users `/ficus` slash commands in their server; a
consultant answers and forwards action requests to squad managers. Every step is
instance-level. Squad routing lives in the channel instance (step 6).

Check what exists first: `ficus channel list`, and **Connection status** in
**Settings → Integrations → Discord**. If Discord is already set up, you only need
to change the channel instance's routing (`ficus channel update <id> --default-squad`
or `--channel-squad-map`).

The human performs the Developer Portal steps and enters the credential. Never ask
for the token in chat. Never read, print, log or commit it, even if volunteered.
Channel plugins have no command execution, so no channel token belongs in a
sandbox or `integration exec` command. Saved changes reconcile without a manual
restart.

## 1. Create the application and bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application**, named for example "Ficus". Ficus discovers the Application
   ID and public key during connection setup; do not ask the human to copy either.
2. **Bot** section: **Reset Token** and keep it for the Ficus form.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent** (needed
   for thread replies).

## 2. Configure the integration

The human opens **Settings → Integrations → Discord** and enters only the
**Bot token**. Bot token is the only credential field. Save, validate and enable.
Ficus discovers the Application ID and public key through Discord; the public key
stays hidden.

After the bot is invited (step 4), the card discovers its servers. With more than
one, choose **Server the bot answers in** under **Default squad**; the choice shows
as **Server ID**. Command registration follows the selected server, and is global
without one.

## 3. Optional HTTP interactions endpoint

HTTP delivery is optional: slash commands work through the gateway with no public
endpoint. For HTTP delivery only, copy the **Interactions Endpoint URL** from the
Discord card, including any public base path, into **General Information →
Interactions Endpoint URL** in the Developer Portal. Never infer an API hostname
from `APP_URL`.

## 4. Invite the bot

**OAuth2 → URL Generator**: scopes `bot` and `applications.commands`; permissions
Send Messages, Use Slash Commands, Send Messages in Threads and Create Public
Threads. Open the generated URL and authorize the target server.

## 5. Slash commands

Core registers commands when the connection changes. Global commands can take up to
an hour to appear; a selected server gets guild commands immediately.

```bash
ficus discord status
ficus discord register                 # retry registration
ficus discord clear --scope global     # then register again, if commands are duplicated
```

## 6. Channel instance

The guild id comes from right-clicking the server name → Copy Server ID (Developer
Mode must be on: User Settings → Advanced).

```bash
ficus channel create \
  --id "client-discord" \
  --name "Client Discord Server" \
  --provider discord \
  --config '{"guildId": "GUILD_ID_HERE"}' \
  --default-squad "<squad-uuid>"

# Optional: route specific Discord channels to other squads. Replaces the whole map.
ficus channel update client-discord \
  --channel-squad-map '{"<discord-channel-id>": "<squad-uuid>"}'
```

## 7. Verify

Ask the human to run `/ficus help`, `/ficus status` and `/ficus ask How are you?`
in the server.

| Problem                    | Check                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Commands missing           | Global propagation delay, the server selection, `ficus discord status`                                       |
| Bot silent                 | Connection validation and gateway status, bot invitation, routing; replace a rejected token only in the card |
| HTTP endpoint fails        | Connection status and endpoint reachability; never retrieve keys                                             |
| Thread replies ignored     | **Message Content Intent** is enabled                                                                        |
| "Thinking..." never clears | Core logs for the consultant execution                                                                       |
