# Channel Notifications (Discord/Slack/Telegram)

Send bundled high-signal notifications to Discord, Slack, and Telegram when key events occur in Ficus. Notifications reuse the same channel instance bots configured for slash commands. Blocked events remain supported through explicit custom rules.

## Quick Setup

The easiest way to configure notifications is via slash commands from the target channel:

```
/ficus notify <squad-name>     # Subscribe this channel to squad notifications
/ficus unnotify <squad-name>   # Unsubscribe
```

## Configuration

### Via Web UI

1. Go to Squad → Settings → Notifications
2. Select channel instance and enter channel/chat ID
3. Save changes

### Via CLI

```bash
# Discord
ficus squad set-meta <squad-id> notifications.discord.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.discord.channelId "<channel-id>"

# Slack
ficus squad set-meta <squad-id> notifications.slack.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.slack.channelId "<channel-id>"

# Telegram
ficus squad set-meta <squad-id> notifications.telegram.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.telegram.channelId "<chat-id>"

# Remove notifications
ficus squad set-meta <squad-id> notifications.discord null
```

## Supported Events

Configured in `config/notifications/rules.yaml`:

| Event                 | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `workStream.blocked`  | Agent needs input to continue (custom opt-in; no bundled external route) |
| `workStream.review`   | Work stream ready for human review                                       |
| `workStream.done`     | Work stream completed                                                    |
| `execution.completed` | Agent execution finished                                                 |
| `execution.failed`    | Agent execution failed                                                   |

To route blocked events deliberately to a dedicated operations channel, add an explicit rule:

```yaml
rules:
  - event: 'workStream.blocked'
    channels: [discord, slack, telegram]
```

This opt-in changes only external delivery; blocked events remain visible in the UI and Activity regardless.

## Message Format

### Discord

- Embedded message with title, description, and color
- Colors: red (blocked/failed), yellow (review), green (done/completed)
- Footer shows squad name and timestamp
- Optional URL button if `APP_URL` is configured

### Slack

- Block Kit format with header, section, context
- Optional button linking to relevant page
- Context footer shows squad name

### Telegram

- MarkdownV2 formatted message
- Emoji indicators for status
- Inline link button if `APP_URL` is configured

## Architecture

```
Event Emitter
    ↓
NotificationService (services/notifications/)
    ↓
rules.yaml (routing)
    ↓
┌─────────────┬──────────────┬──────────────┐
│   console   │     push     │   external   │
│   (log)     │   (webpush)  │  (channels)  │
└─────────────┴──────────────┴──────────────┘
                                   ↓
                        ChannelProvider.sendNotification()
                                   ↓
                        Squad.metadata.notifications config
                                   ↓
                        Discord/Slack/Telegram API
```

The notification service:

1. Listens to all events via `eventEmitter.onAny()`
2. Matches events against rules in `rules.yaml`
3. Routes to configured channels
4. For external channels, looks up squad notification config and channel instance
5. Calls provider's `sendNotification()` method

## Environment Variables

```bash
# Required for each channel you want to use
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...
TELEGRAM_BOT_TOKEN=...

# Optional - enables clickable URLs in notifications
APP_URL=https://your-domain.com
```

## Adding Event Builders

To send new event types to external channels, add a builder in `apps/core/src/services/notifications/event-builders.ts`:

```typescript
'myEvent.type': async (data) => {
  // Extract IDs from event data
  const thingId = data.thingId as string
  if (!thingId) return null

  // Look up entities
  const thing = await Thing.find(thingId)
  if (!thing) return null

  return {
    type: 'myEvent.type',
    squadId: thing.squadId,
    squadName: squad.name,
    title: `🎉 Something happened`,
    body: thing.description,
    url: buildUrl(`/things/${thing.id}`),
    timestamp: new Date(),
  }
}
```

Then add the event to `config/notifications/rules.yaml`:

```yaml
- event: 'myEvent.type'
  channels: [discord, slack, telegram]
```
