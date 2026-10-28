---
name: setup-telegram
description: 'Set up Telegram through its integration card and create channel routing; Core owns webhook registration.'
---

# Setting Up Telegram Integration

Telegram connects bot commands and replies to consultant conversations and squad
routing. Inspect existing routing first:

```bash
ficus channel list
ficus webhook status telegram
```

## Step 1: Create the bot

Walk the human through [@BotFather](https://t.me/BotFather): send `/newbot`, choose
a display name and a username ending in `bot`. They keep the bot token private.
Core discovers the numeric Bot ID and username when validating the connection.

## Step 2: Connect in the owning panel

Ask the human to open **Settings → Integrations → Telegram**, enter the bot token,
save, validate and enable the connection. The panel generates
its webhook signing secret. Saved credentials stay hidden; rotate by replacing
them in this panel. Never ask for credentials in chat, even if volunteered.
Never read, print, log or commit tokens or signing secrets. Do not copy them into
sandbox environments/files or use integration exec: channel plugins have no
command execution declaration.

## Step 3: Let Core register the webhook

Core registers the webhook using the saved connection and generated signing
secret, and reconciles on connection changes. Do not register it with a
provider-API shell command, read a token, or manually restart Ficus. The owning
panel supplies the exact webhook URL, including any public base path; never
infer an API hostname from `APP_URL`.

## Step 4: Create Channel Instance

Use the nonsecret numeric Bot ID discovered by validation and displayed in the
integration card (not the username or any part of a token):

```bash
ficus channel create \
  --id "client-telegram" \
  --name "Client Telegram Bot" \
  --provider telegram \
  --config '{"botId": "123456789"}' \
  --default-squad "<squad-uuid>" \
  --linked-squads "<squad-uuid>"
```

## Step 5: Verify

```bash
ficus webhook status telegram
ficus channel list
```

Ask the human to message the bot: `/help` should show commands, and a normal
message should receive a consultant reply. Replies to messages retain context.

## Troubleshooting

- Webhook registration fails: check connection validation/enablement in the
  Telegram card and that its displayed public webhook URL is reachable.
- Bot does not respond: verify the discovered numeric Bot ID and channel routing.
- Webhook authentication fails: replace credentials through the owning panel
  and let Core reconcile; never retrieve a signing secret or use a token URL.
