# Notification System

The notification system routes events to delivery channels (push notifications, console logging, Discord/Slack/Telegram) based on configurable YAML rules. It uses a "first match wins" strategy with per-channel enable/disable controls.

## Quick setup (CLI)

Point a squad at a channel the bot is already in (`instanceId` from
`config/channels/`, `channelId` from the chat platform):

```bash
ficus squad set-meta <squad-id> notifications.discord.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.discord.channelId "<discord-channel-id>"
```

Slash-command, web-UI and per-platform variants, plus the events that fire, are
in [Channel Notifications](outbound-notifications.md); the bot itself is set
up in [channels.md → Notifications](channels.md#notifications).

## Architecture

```
Event Emitter
     │  (onAny)
     ▼
NotificationService.notify()   (matches event/data rule, resolves recipients)
     │
     ├─► Console channel       (logs to stdout)
     ├─► Push channel          (shared recipients and preferences)
     │     ├─► Web Push        (browser subscriptions)
     │     ├─► APNs            (mobile devices)
     │     └─► Desktop feed    (local Electron OS alerts)
     └─► External channels     (Discord, Slack, Telegram)
              │
              ▼
         Event Builder         (builds NotificationEvent from raw data)
              │
              ▼
         Squad config          (metadata.notifications.{discord,slack,telegram})
              │
              ▼
         Channel Provider      (sendNotification via bot API)
```

## Key Files

| File                                                      | Purpose                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/core/src/services/notifications/service.ts`         | Core `NotificationService` class (includes `register()` for event subscription) |
| `apps/core/src/services/notifications/types.ts`           | Type definitions                                                                |
| `apps/core/src/services/config-sync/notification-sync.ts` | Syncs notification config from YAML templates to DB                             |
| `config/notifications/rules.yaml`                         | Template rule definitions (synced to DB on startup)                             |
| `apps/core/src/services/push/subscriptions.ts`            | Push subscription CRUD (database)                                               |
| `apps/core/src/services/push/vapid.ts`                    | VAPID key management                                                            |
| `apps/core/src/services/push/apns.ts`                     | Direct APNs sender (HTTP/2 + ES256 provider JWT)                                |
| `apps/core/src/services/push/apns-devices.ts`             | APNs device-token registration (database)                                       |
| `apps/core/src/services/push/desktop.ts`                  | Desktop alert feed, deduplication, retention, and preference checks             |
| `apps/core/src/routes/push.ts`                            | HTTP endpoints for Web Push + native device registration                        |

## Initialization

On startup, `NotificationSync` syncs the YAML template to the `notification_config` DB table. The `NotificationService` loads its config from the database and subscribes to all events via the emitter's `onAny()`. Config can be edited via the Settings UI — admin changes are preserved across syncs.

The subscription observes new event types added to `EventMap`, but observation alone does not make an event deliverable. A notification needs a matching rule, an event builder, and resolvable recipients. All three push paths share those decisions; desktop has no separate event allowlist.

## Rule Matching

Rules are evaluated in order — **first match wins**. Each rule can filter on:

- `event` — exact event name (for example, `agent-question.created`).
- `match` — conditions on event data, with dotted paths for nested fields. Each condition must match; an array accepts any listed value.

Omitted filters match anything. A matching rule supplies a `channels` array, and delivery skips channels explicitly disabled in the configuration. Current rules do not derive or match an `urgency` field, and the older singular `channel` syntax is not the current schema. A stable optional `id` distinguishes rules for template override tracking.

## Channels

### Console

Logs `<event>: <summary>` through the `notify` logger. Useful for development and monitoring.

### Push channel

The `push` channel resolves recipients and applies preferences once, then fans out to Web Push, APNs, and (only when `FICUS_DESKTOP_MANAGED=1`) the desktop feed. Each delivery path has its own transport configuration; desktop delivery does not require Web Push subscriptions or APNs credentials.

### Web Push

Sends browser push notifications via the [Web Push protocol](https://web.dev/push-notifications-overview/):

1. Loads VAPID credentials from SecretStore, with legacy-file migration and generation fallback (see [VAPID keys](#vapid-keys)). Browser delivery requires the Web Push integration to be enabled and a valid `VAPID_SUBJECT` contact (`mailto:` or HTTPS).
2. Resolves target users from the event's notify-level attention audience (or explicit inbox recipients), then applies each user's master push toggle and muted-event preferences.
3. Loads only those users' subscriptions and builds a payload with `title`, `body`, `url`, and relevant entity/action identifiers.
4. Sends to each subscription via `web-push`.
5. Removes invalid subscriptions on 410/404 responses only if the stored subscription has not changed since the send began.

For `agent-question.created`, recipients are the question's durable direct recipients and compatible personal owner, plus every user holding `actions:read` whose effective `decisions` level is `notify` for the question's squad or one of its work-stream origins. Other events require recipient fields: `user` targets that user, `voice_assistant` resolves either the owner of a saved Assistant conversation (`assistant:<conversation UUID>`, nobody once the conversation is deleted) or the workspace voice user, and `system` targets users with `inbox:system`. Events without resolvable recipients do not broadcast to every browser, even when their rule includes `push`. Personal preferences apply after recipient resolution: attention decides WHO, the per-user category mutes decide WHETHER the device rings.

### Push Notification Content

Event builders construct the rich title, body, and destination. Device delivery applies the recipient’s `showPreviews` preference (default true; users can opt out). With previews off, Web Push and APNs alerts use a closed event vocabulary and an instance-wide work number, for example “Work #42 needs your answer”. Live Activity content is similarly redacted, including the authenticated snapshot used to start an activity. Widget work-list data remains authenticated and contains titles. With previews on, bounded title/body content is sent through the configured push path. For example, `agent-question.created` includes the agent label and persisted question text; its link opens `/squads/<squadId>?agent=<agentId>` for a squad agent or `/chat/<agentId>` otherwise. Inbox notifications link to `/inbox`. Saved Assistant task updates are the exception: they use the fixed title “Assistant update”, the body “A task has an update. Open Assistant to view it.”, and link to the conversation itself (`/?chat=open&assistantConversation=<id>`), never to the sender agent or the inbox; only status-changing `needs-input`, `completed`, and `failed` reports on a task's current request are push-eligible (see [Assistant tasks](assistant-tasks.md)). Structured identifiers in the payload also let clients open the relevant question or work stream.

### Native push (APNs)

The mobile app receives **native iOS push via direct APNs** (HTTP/2 + an ES256 provider JWT) — no third-party push service. APNs participates in the shared push fan-out alongside Web Push and desktop; tokens APNs reports as unregistered (`410` / `Unregistered`) are pruned automatically.

- Devices register with `POST /api/push/device`; tokens are stored per-user in the `apns_devices` table with the APNs environment (`sandbox` or `production`) used by that build.
- Credentials come from the [Secret Store](secret-store.md) (`APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, optional `APNS_ENV`), configured in **Settings → Integrations → Apple Push**. They're read live per send, so first-time setup needs no restart; APNs is active when Apple Push is enabled and all four required keys are set.
- The stored device environment selects the Apple endpoint per send: sandbox devices use `api.sandbox.push.apple.com`, and production devices use `api.push.apple.com`. `APNS_ENV` is only the fallback/default when no device-specific environment is available.
- `BadDeviceToken` is logged but not pruned, because it often indicates a gateway/environment mismatch rather than a permanently invalid token.

See [Mobile App → Push notifications](mobile-app.md#push-notifications-apns) for the device side.

### Desktop notifications

Desktop-managed instances store a per-user presentation copy in `desktop_notifications`. The signed-in web shell polls the local API and passes alerts through a narrow Electron bridge for OS display. This allows catch-up after reconnecting without a browser push service or cloud relay. Normal browser sessions do not poll this feed.

The feed returns at most 100 recent alerts from seven days; expired rows are purged on subsequent enqueues. Current mute and preview preferences are rechecked on reads. A hidden or minimized window continues receiving alerts; quitting the app stops delivery until reopening. Displaying an alert never marks inbox messages read or advances work. See [Desktop notifications](desktop-notifications.md) for delivery, deduplication, privacy, and bridge boundaries.

### Adding a notification type

1. Define and emit the event through the shared event emitter. Add its presentation to `apps/core/src/services/notifications/event-builders.ts`; an event without a builder cannot produce a push alert.
2. Add or update the rule in `config/notifications/rules.yaml` to select `push`. Preserve administrator overrides through the existing config sync.
3. Supply the recipient fields understood by `resolveEnabledPushUserIds`, or extend that shared resolver for a new audience. Update `push-category.ts` when a new event needs a category other than the `message` fallback.
4. Test the builder, audience, rule, and mutes. Update shared Web Push/APNs preview vocabulary if needed. Do not add desktop-specific event routing: the same built event and selected recipients already reach its feed.

`services/notifications/service.test.ts` includes a regression that registers a new event builder and push rule, then verifies Web Push, APNs, and the persisted desktop alert all receive the same event for the selected user. Muting that event suppresses all three paths. This test must fail if desktop delivery is removed from the shared fan-out.

### External Channels (Discord, Slack, Telegram)

External channels send notifications to chat platforms via their bot APIs. They reuse the same channel instance bots configured for slash commands.

**Setup:** See [Channel Notifications](outbound-notifications.md) for detailed setup.

**Quick setup via slash commands:**

```
/ficus notify <squad-name>     # Subscribe channel to squad notifications
/ficus unnotify <squad-name>   # Unsubscribe
```

**How it works:**

1. Event matches a rule with `discord`, `slack`, or `telegram` in `channels`
2. `NotificationService` checks if provider has `sendNotification` support
3. `buildNotificationEvent()` constructs title, body, URL from raw event data
4. Service looks up squad's notification config (`squad.metadata.notifications.<channel>`)
5. Loads the channel instance and calls `provider.sendNotification()`

**Event builders:** External channels require an event builder to format the notification. Builders are defined in `apps/core/src/services/notifications/event-builders.ts`. If no builder exists for an event type, external channel delivery is skipped.

**Required credentials** (managed in each channel’s Settings → Integrations card):

- `DISCORD_BOT_TOKEN` — Required for Discord notifications (requires restart after change)
- `SLACK_BOT_TOKEN` — Required for Slack notifications (requires restart after change)
- `TELEGRAM_BOT_TOKEN` — Required for Telegram notifications
- `APP_URL` — Optional, enables clickable links in notifications

## Push Subscription Management

Browsers register for push notifications via the Settings page in the web UI:

1. Browser requests VAPID public key: `GET /api/push/vapid-public-key`
2. Browser creates a PushSubscription via the Push API
3. Browser sends subscription to server: `POST /api/push/subscribe`
4. Server stores `endpoint`, `p256dh` key, and `auth` secret in the database

### VAPID Keys

VAPID (Voluntary Application Server Identification) keys are loaded on demand, with SecretStore keys `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` taking precedence. If absent, Ficus reads the legacy file (`config/vapid.json`, or `VAPID_KEYS_PATH`) and attempts to migrate its keys to SecretStore. If neither source provides keys, Ficus generates them and attempts to persist them in SecretStore; it also writes the compatibility file. Store/file persistence is best effort, so the legacy file can remain the source when SecretStore writes fail. The public key is served to browsers for subscription creation; the private key signs push messages.

## Rules Configuration

Rules are stored in the `notification_config` DB table, synced from the YAML template on startup, and editable via the Settings UI. The template file is `config/notifications/rules.yaml`:

```yaml
rules:
  - event: 'agent-question.created'
    channels: [push]

  - id: 'assistant-task-update'
    event: 'inbox.messageReceived'
    match:
      recipientType: 'voice_assistant'
      assistantPush: true
    channels: [push]

  - event: 'inbox.messageReceived'
    match:
      recipientType: [user, system]
    channels: [push]

  - event: 'execution.failed'
    channels: [console]

channels:
  console:
    enabled: true
  push:
    enabled: true
```

This is a small example; the bundled template also routes supported work-stream and fleet events to external channels.

## Event Flow Example: Agent Question

1. **Worker:** The asynchronous `ask_human` tool creates a persisted question and attention recipients.
2. **Worker:** `agent-question.created` fires locally and forwards to the API over the loopback event transport.
3. **API:** The listener calls `notificationService.notify()` and the first matching rule selects `push`.
4. **API:** The event builder loads the question; recipient resolution takes its direct recipients and personal owner, adds the authorized users whose effective `decisions` level is `notify` for its squad or origins, and applies personal push preferences.
5. **API:** Web Push and APNs delivery run in parallel for those users' registered browsers/devices.
6. **Client:** The notification opens the relevant question when selected.

## Work-stream owner notification

When a work stream is created by one agent on behalf of another (i.e. `creatorAgentId` is set and differs from `ownerAgentId`), the **owner is notified at creation time** via an inbox message: "New work stream you own, started by `<creator>`: `<title>`".

This is a general mechanism that benefits any agent-to-agent handoff. Its first consumer is the [Consultant](consultant.md): when a Consultant creates a work stream owned by the squad manager, the manager receives the notification immediately without polling.

**Conditions for the notification to fire:**

1. `creatorAgentId` is set (agent-initiated; user-created streams leave it null)
2. `ownerAgentId` is set and `ownerAgentId !== creatorAgentId`

**Deduplication:** if the owner is also the assignee _and_ the assignee notification was sent (i.e. the assignee is not the squad manager, which the existing `notifyWorkStreamAssigned` skips), the owner notification is suppressed to avoid double-notifying. In the Consultant handoff case — where the owner/assignee is the squad manager — the owner notification always fires because `notifyWorkStreamAssigned` skips manager assignees.

The `creatorAgentId` is captured from the request identity in `POST /work-streams` and stored in `work_streams.creatorAgentId` (nullable FK → `agents.id`, `onDelete: set null`).

**Key files:**

- `apps/core/src/services/squad/work-stream-notifications.ts` — `notifyWorkStreamOwnerOfNewStream`
- `apps/core/src/entities/WorkStream.ts` — `createWorkStream` stores `creatorAgentId` and calls the notification
- `apps/core/src/routes/work-streams.ts` — threads `identity.agentId` as `creatorAgentId`

## Work-stream attention (human watchers)

Human recipients of a work stream's notices come from attention rows, not from a boolean watch:

| Notice    | Kind that decides | Push category |
| --------- | ----------------- | ------------- |
| `review`  | `decisions`       | `review`      |
| `blocked` | `decisions`       | `review`      |
| `done`    | `progress`        | `done`        |

For each notice the server loads that stream's rows and its squad's rows — a bounded candidate set — and keeps the users whose effective level for the deciding kind is `notify` (stream row first, then squad row; no row means `show`, which never notifies). Every other lifecycle event (`assigned`, `canceled`, `reopened`, `dependency_canceled`, `idle`, `unblocked`, `reviewed`, `updated`) stays agent-facing.

Live Activity and the work-list widget use the same rows the other direction: a squad or work stream appears there once either kind's effective level is `notify` — the same threshold push uses.

## Debugging

Logs to look for in API process:

- `[NOTIFY] <event> → <channel>` — event reached notification service, rule matched
- `Resolved push recipients for <event>: ...` — user selection result
- `No push recipients for <event>; skipping push` — no eligible recipients
- `No web push subscriptions for N recipient(s); skipping web push` — eligible users have no browser subscriptions
- `Sending web push to N subscription(s)` — browser push delivery attempted
- `<event>: <summary>` in the notify logger — console channel delivery
- `Failed to send push to <id>: <error>` — push delivery failure
- `Removed invalid push subscription <id>` — stale subscription cleaned up

If no `[NOTIFY]` logs appear for worker-originated events, the distributed event emitter is not forwarding — check the loopback event transport (`apps/core/src/lib/infra/local-events.ts`): the worker logs `Failed to forward 'app_events'` when it cannot reach the API, and a mismatched `FICUS_INTERNAL_EVENT_TOKEN` between the two units shows up as `HTTP 401`.
