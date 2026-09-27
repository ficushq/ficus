---
name: setup-telegram
description: 'Set up Telegram bot integration — create the bot via BotFather, register the webhook, and create the channel instance.'
---

# Setting Up Telegram Integration

## Overview

Telegram integration gives users bot commands in Telegram chats. A consultant
agent handles incoming messages, answers questions, and forwards action requests
to squad managers. Thread replies via Telegram's reply-to-message feature
maintain conversation context.

## Who Uses This

This is primarily a **System Manager** skill — either agent can walk
the human through setup. All steps are instance-level. Squad managers do not
need this — squad linking is configured in the channel instance (Step 4).

**Before starting, check what's already configured:**

```bash
# Check if Telegram secrets exist
ficus secret list | grep TELEGRAM

# Check if channel instances exist
ficus channel list
```

If Telegram is already set up, you only need to update the channel instance
to link additional squads.

## How Secrets Are Handled

- **Auto-generated secrets** (webhook secret): Set directly via CLI from
  `openssl rand` output. Don't read the value — tell the human it's been
  generated and they can view/copy it in **Settings → Integrations → Telegram**.
- **User-provided secrets** (bot token, bot ID): Direct the human to enter
  them in **Settings → Integrations → Telegram**. If they offer to paste a value and
  want you to set it, you can use `ficus secret set`.

## Prerequisites

- The **API URL** from the Platform URLs section in your system prompt
- The human must interact with @BotFather on Telegram
- At least one squad must exist to link the channel to

> **Note:** Your system prompt includes a "Platform URLs" section with the Web UI,
> API, and webhook endpoint URLs. Use the API URL from there in the steps below.
> It is also available as the `$APP_URL` env var (web UI URL) in sandbox shells.

## Step 1: Create the Telegram Bot

**Walk the human through:**

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts:
   - Choose a display name (e.g., "Ficus")
   - Choose a username (must end in `bot`, e.g., `myficus_bot`)
3. Copy the **bot token** (format: `123456789:ABCdef...`)
4. Note the bot's username (without `@`)

## Step 2: Configure Secrets

### Webhook Secret (auto-generated)

```bash
ficus secret set TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
```

Tell the human: "I've generated a random Telegram webhook secret. You can view
it in **Settings → Integrations → Telegram** if needed."

### Bot Token and Bot ID (user-provided)

Direct the human to enter the following in **Settings → Integrations → Telegram**:

- `TELEGRAM_BOT_TOKEN` — the bot token from BotFather
- `TELEGRAM_BOT_ID` — the bot username without `@` (e.g., `myficus_bot`)

If the human pastes a value in chat and wants you to set it, use
`ficus secret set <key> "<value>"`.

Restart the API:

```bash
ficus system restart
```

## Step 3: Register the Webhook

Register the webhook URL with Telegram's API. This requires reading the secrets:

```bash
BOT_TOKEN=$(ficus secret get TELEGRAM_BOT_TOKEN)
WEBHOOK_SECRET=$(ficus secret get TELEGRAM_WEBHOOK_SECRET)
# API_URL is derived from APP_URL: https://foo.example.com → https://api-foo.example.com
API_URL="https://api-${APP_URL#https://}"

curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${API_URL}/api/webhooks/channels/telegram&secret_token=${WEBHOOK_SECRET}" | jq .
```

Expected response: `{"ok": true, "result": true, "description": "Webhook was set"}`

## Step 4: Create Channel Instance

```bash
BOT_ID=$(ficus secret get TELEGRAM_BOT_ID)

ficus channel create \
  --id "client-telegram" \
  --name "Client Telegram Bot" \
  --provider telegram \
  --config "{\"botId\": \"${BOT_ID}\"}" \
  --default-squad "<squad-uuid>" \
  --linked-squads "<squad-uuid>"
```

## Step 5: Verify

Ask the human to test:

1. Start a chat with the bot on Telegram
2. Send `/ficus help` or just `/help` — should show available commands
3. Send a message — should get a response from the consultant

Verify webhook info programmatically:

```bash
BOT_TOKEN=$(ficus secret get TELEGRAM_BOT_TOKEN)
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq .
```

Check that `url` is correct and `last_error_date` is absent.

## Troubleshooting

| Problem                     | Solution                                                      |
| --------------------------- | ------------------------------------------------------------- |
| Webhook registration fails  | Verify bot token is correct, API URL is publicly reachable    |
| Bot doesn't respond         | Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_ID` match        |
| 401 on webhook delivery     | `TELEGRAM_WEBHOOK_SECRET` mismatch — re-register the webhook  |
| getWebhookInfo shows errors | Check `last_error_message` for details, verify API is running |
