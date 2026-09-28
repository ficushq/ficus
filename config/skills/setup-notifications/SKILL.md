---
name: setup-notifications
description: 'Configure squad notifications — set up push notifications and route events to Discord, Slack, and Telegram channels.'
---

# Setting Up Notifications

## Overview

Ficus sends bundled high-signal notifications when work streams need review or
complete. Blocked notifications require an explicit custom rule. Notifications
go to browser push notifications and/or external channels (Discord, Slack,
Telegram). Each squad configures its own notification targets.

## Who Uses This

- **System Manager** — Can configure notifications for any squad during onboarding.
- **Squad Manager** — Can configure notifications for their own squad.

Both roles use the same steps. Notifications are per-squad, so there's no
instance-level setup to worry about duplicating.

**Before starting, check existing notification config:**

```bash
ficus squad get <squad-id>   # look for metadata.notifications
```

## Notification Events

| Event                 | Description                        | Default Channels                 |
| --------------------- | ---------------------------------- | -------------------------------- |
| `workStream.blocked`  | Agent blocked and needs help       | none (explicit custom rule only) |
| `workStream.review`   | Work stream ready for human review | push, discord, slack, telegram   |
| `workStream.done`     | Work stream completed              | discord, slack, telegram         |
| `execution.completed` | Agent execution finished           | console                          |
| `execution.failed`    | Agent execution failed             | push, console                    |

## Prerequisites

- For channel notifications: the channel bot must already be set up
  (see the `setup-discord`, `setup-slack`, or `setup-telegram` skills)
- For push notifications: the web UI handles this automatically via VAPID keys
  (auto-generated on first boot)

## Option 1: Use Slash Commands (Easiest)

If the channel bot is already set up, the simplest way to subscribe a channel
to notifications is from within that channel:

```
/ficus notify <squad-name>
```

To unsubscribe:

```
/ficus unnotify <squad-name>
```

This automatically configures the current Discord/Slack/Telegram channel to
receive notifications for the specified squad.

## Option 2: Configure via CLI

Set notification metadata on the squad. You need:

- The **channel instance ID** (from `ficus channel list`)
- The **platform channel ID** (Discord channel ID, Slack channel ID, or Telegram chat ID)

```bash
# Discord notifications
ficus squad set-meta <squad-id> notifications.discord.instanceId "<channel-instance-id>"
ficus squad set-meta <squad-id> notifications.discord.channelId "<discord-channel-id>"

# Slack notifications
ficus squad set-meta <squad-id> notifications.slack.instanceId "<channel-instance-id>"
ficus squad set-meta <squad-id> notifications.slack.channelId "<slack-channel-id>"

# Telegram notifications
ficus squad set-meta <squad-id> notifications.telegram.instanceId "<channel-instance-id>"
ficus squad set-meta <squad-id> notifications.telegram.channelId "<telegram-chat-id>"
```

### Finding Platform Channel IDs

- **Discord:** Right-click the channel → Copy Channel ID (enable Developer Mode
  in Discord: User Settings → Advanced → Developer Mode)
- **Slack:** Click channel name → About → scroll to the bottom for Channel ID
- **Telegram:** Use the `/ficus notify` command, or check the bot API

## Option 3: Configure via Settings UI

1. Navigate to the squad's detail page
2. Go to the **Settings** tab → **Notifications** section
3. For each platform, select the channel instance and enter the channel ID
4. Save changes

## Notification URLs

Notifications include clickable links to the Ficus web UI automatically when
`APP_URL` is set. In Kubernetes deployments, `APP_URL` is configured by the
infrastructure — no manual setup needed.

## Disabling Notifications

Remove notification config for a specific platform or all platforms:

```bash
# Remove Discord notifications for a squad
ficus squad set-meta <squad-id> notifications.discord null

# Remove all notifications for a squad
ficus squad set-meta <squad-id> notifications null
```

## Push Notifications (VAPID)

Browser push notifications work automatically. VAPID keys are generated on
first startup and saved to `config/vapid.json`.

For iOS/Safari support, direct the human to set `VAPID_SUBJECT` in **Settings →
Integrations → Web Push** to a valid `mailto:` address (e.g., `mailto:admin@example.com`).
Apple's push service rejects `.local` domains, so this is required for iOS.

## Troubleshooting

| Problem                        | Solution                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| No notifications received      | Verify squad metadata has notification config set             |
| Discord notifications fail     | Check bot is in the target channel and has Send Messages perm |
| Slack notifications fail       | Check bot token has `chat:write` scope                        |
| Push notifications not working | Check VAPID keys exist in `config/vapid.json`                 |
| No links in notifications      | Verify `APP_URL` env var is set (auto-configured in K8s)      |
