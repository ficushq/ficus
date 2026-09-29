# Channel Integration

## Settings location

Discord, Slack, and Telegram are separate cards in **Settings → Integrations**.
Each card holds one **connection** for the provider: paste the bot token (and
the Slack signing secret), and Ficus validates it, records the bot's identity, and
does the provider-side registration itself. Secret fields show whether a value
is configured without revealing it, and credentials are not edited through
Secrets & Keys. Existing configured bots remain enabled on upgrade; new
integrations start disabled.

Pick a **Default squad** on the card and messages arriving through that bot
route there. **Channel routing** on the card holds per-channel overrides. The
default squad is required. UI-created routing is saved directly; it does not
require a YAML file or a configuration-sync restart. You need `channels:create`
to add routing and `channels:update` to change it; credential edits require the
provider's integration permission (`integrations:<provider>:write`).

The integration switch gates the transport; disabling Discord also stops its
gateway, and saving a new token reconnects it. Slack clients pick up token
changes on their next request.

Channels connect external platforms (Discord, Slack, Telegram) to Ficus squads via
a **consultant agent**. The consultant is a member of its routed
squad: it answers questions and creates work streams directly, with its configured
permissions and tools. It forwards squad-specific operational decisions when
appropriate rather than forwarding every action request to a manager.

## Overview

```
Discord/Slack User
       ↓
  Webhook Endpoint
       ↓
  Consultant Agent (per conversation, in the routed squad)
       ↓
  ┌─────────────────────────────────────┐
  │ Can handle directly:                │
  │ - Status checks (/ficus status)       │
  │ - Questions (/ficus ask)              │
  │ - Create and follow work streams   │
  └─────────────────────────────────────┘
       ↓ (when an operational decision needs the manager)
  Squad Manager
       ↓
  ┌─────────────────────────────────────┐
  │ Requires manager:                   │
  │ - Squad-specific operations        │
  └─────────────────────────────────────┘
```

## Commands

| Command            | Description                    | Handler    |
| ------------------ | ------------------------------ | ---------- |
| `/ficus status`    | Show active work streams       | Immediate  |
| `/ficus <message>` | Ask questions or make requests | Consultant |

The consultant handles all freeform messages intelligently:

- **Questions** — Answered directly by searching memory, checking status, etc.
- **Action requests** — The consultant can create and own work in its routed
  squad. Operational decisions may be forwarded to the squad manager.

## Sender authorization and conversation reuse

Ingress verifies the provider signature (or Discord gateway session) before using
its sender ID. `channel-access.ts` checks either an exact trusted channel ID or a
confirmed external identity linked to an enabled Ficus user with current `chat:send`
permission for the routed squad. Permission lookup bypasses the RBAC cache so
revocation applies to the next message. Help and account linking do not start an
agent and are available before this check. Notification commands can change only
the squad routed to that channel.

`/api/channel-links` is a personal authenticated-user API. A user starts a random,
short-lived challenge in Ficus, submits it through authenticated provider ingress,
and confirms the displayed sender in Ficus. Only hashes are stored. Confirmation
and uniqueness checks happen in a transaction. Links bind the instance and its
provider identity, not display names; reusing a routing record for another Slack
workspace invalidates old proofs and access. Unlink and disabled users fail closed.

Trusted channels explicitly bypass user linking. Anyone who can message there can
direct squad agents, including asking the manager to act. This is not a restricted
query interface. Replies remain in the originating channel; the sender chooses
the audience. Thread history excludes unlinked/unpermitted senders outside trusted
channels. Discord routing and trust use a verified parent channel for threads.

In shared channels, Slack and Discord continue a conversation on an explicit bot mention in a thread;
unmentioned replies are ignored. Discord also accepts slash commands in a thread.
Telegram group chats reuse one conversation per chat and respond to group
`/ficus` commands, and replies to bot messages. Lookups are scoped to provider,
instance, channel, thread, and the currently routed squad. A changed squad override
does not resume an agent in the old squad.

Telegram's persistent conversation ID is its chat ID. It must never be passed as
`reply_to_message_id`: `postMessage.replyToMessageId` carries an optional incoming
message ID separately. Follow-up acknowledgements reply to that message; later
updates may post without a reply target.

## Private bot conversations and squad selection

Only verified one-to-one bot DMs use `channels/direct-messages.ts`. Telegram marks
native `chat.type=private`, Slack uses `channel_type=im` (and verifies slash-command
DMs with `conversations.info`), and Discord uses native channel type 1 or the authenticated `BOT_DM` interaction context. Group
DMs and private server channels do not enable user-directed routing. Discord
subscribes to `DIRECT_MESSAGES`; since a DM has no guild ID, it uses the configured
bot connection's server to resolve the routing instance and linked identity.

`/ficus squad <slug, name or ID>` selects a permitted squad; no argument lists choices.
Slug assignment uses shared `squadSlugMap` over the user's visible, non-anonymous,
non-archived squad list, matching web URLs and duplicate-name suffixes. Choices
are additionally filtered by fresh `chat:send` permission. Trusted-channel bypass
does not apply to this private flow.

Telegram and Discord scope the selection to a linked identity and DM. Slack
scopes it to each DM thread: a new top-level message gets a reply thread, and a
root slash command creates a real parent message before binding the thread.
Ordinary DM thread replies need no mention. Inside a Slack thread, use
`@Ficus squad <slug>` or `ficus squad <slug>` because Slack custom slash commands are
not available there. Discord has no native DM threads. Guild commands remain
registered for immediate availability; a DM-only global copy propagates separately.

`channel_direct_chats` stores `(link_id, channel_id, thread_id)` and the selected
squad. `channel_direct_agents` stores a consultant binding per `(chat_id, squad_id)`.
The chat row lock serializes selection and first-agent creation across replicas.
All work under the lock uses the transaction executor; agent events emit after
commit. Dormant consultants resume, terminated consultants are replaced, and
creation rolls back with its binding on failure. No provider-wide DM transcript
is imported, since it may mix multiple squads' conversations.

Unlinking cascades both mapping tables. Agent history is retained, but unlinked or
disabled users and revoked squad permissions cannot resume it or receive delayed
responses. Direct response/send/edit tools validate the linked binding and current
RBAC in addition to administrator channel policies. Switching does not cancel old
work. Only switch confirmations name the squad; ordinary replies and updates have no added prefix.

## Connecting a provider

Each provider is one **connection** on the instance, saved from its card in
**Settings → Integrations**. Paste the secret the provider gives you; Ficus
validates it against the provider, records who the bot is (bot id, workspace,
application), and does the provider-side setup that used to be manual. Pick a
**Default squad** on the same card and the routing entry is created for you;
**Channel routing and access** below it is only for per-channel overrides.

Connections are ordinary integration connections: they appear in
`GET /api/integrations/connections?provider=<provider>`, are re-validated by the
revalidation worker, and are audited. The provider switch (**Enable** on the
card, `PUT /api/integrations/providers/<provider>/enabled`) stops the transport
without discarding the credential.

### Telegram

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the
   bot token.
2. Paste it into the Telegram card and save. Ficus calls `getMe` to validate,
   records the bot id and username, generates a webhook secret, and registers
   the webhook (`https://<instance>/api/webhooks/channels/telegram`) with
   Telegram. Switching the provider off removes the webhook.
3. Choose a **Default squad** on the card. Optional: add chat overrides under
   Channel routing.

### Slack

1. On the Slack card, **Download the Slack app manifest** — it already carries
   this instance's URL for the `/ficus` command and Events API.
2. At [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App
   → From an app manifest**, paste it, create, then **Install to Workspace**.
3. Paste the app's **Bot User OAuth Token** and **Signing Secret** into the card
   and save. Ficus calls `auth.test`, records the workspace and bot user id.
4. Choose a **Default squad**. Invite the bot to the channels it should answer in.

Reinstall the Slack app after changing scopes. The manifest's scope list is the
bot's contract; the copy in `config/channels/slack-app-manifest.example.yaml`
is the template the download is rendered from.

### Discord

1. In the [Developer Portal](https://discord.com/developers/applications)
   create an application, open **Bot**, **Reset Token**, and copy it. Under
   **Privileged Gateway Intents** enable **Message Content Intent** (thread
   replies).
2. Paste the token into the Discord card and save. Ficus validates it, records
   the application id and public key from `/applications/@me`, registers the
   `/ficus` slash commands, and (re)connects the gateway.
3. Slash commands work through the gateway without a public endpoint. If you
   prefer HTTP delivery, copy the **Interactions Endpoint URL** shown on the card
   (`https://<instance>/api/webhooks/channels/discord`) into **General
   Information** in the portal; Discord verifies it with the public key Ficus
   already has.
4. Invite the bot: **OAuth2 → URL Generator**, scopes `bot` and
   `applications.commands`, permissions Send Messages, Use Slash Commands, Send
   Messages in Threads, Create Public Threads.
5. Choose the **server** (shown once the bot is in one; picked automatically
   when it is in exactly one) and a **Default squad**. Commands register to that
   server for instant availability; without a chosen server they register
   globally and can take up to an hour to appear.

`ficus discord status` and `ficus discord clear` remain as diagnostics; they take
the bot token and application id as flags or environment variables because the
CLI has no access to the instance's connections. Registration itself no longer
needs the CLI.

### Verifying

```bash
# webhooks:read required — the bootstrap FICUS_PASSWORD works until the first admin passkey exists
curl -H "Authorization: Bearer $FICUS_PASSWORD" https://your-domain.com/api/webhooks/channels/<provider>/status
```

Then `/ficus help` in the provider. The card's **Connection** section shows the
validation state and the identity the provider reported; a rejected credential
is kept and explained there rather than silently ignored.

Apps set up before the rename still register the old slash command, which Ficus no
longer answers. For Slack, download the manifest again and update the app's
slash command to `/ficus`; for Discord, save the card again to register
`/ficus`.

## Channel routing

A routing entry (a _channel instance_) links one provider identity — Discord
server, Slack workspace, Telegram bot — to squads:

| Field                    | Description                                |
| ------------------------ | ------------------------------------------ |
| `id`                     | Unique identifier for the channel instance |
| `name`                   | Human-readable name                        |
| `provider`               | `discord`, `slack`, or `telegram`          |
| `providerConfig.guildId` | Discord guild/server ID                    |
| `providerConfig.teamId`  | Slack workspace ID                         |
| `providerConfig.botId`   | Telegram numeric bot ID                    |
| `channelSquadMap`        | Map specific platform channels to squads   |
| `defaultSquadId`         | Default squad for unrouted requests        |

Choosing a **Default squad** on the provider card creates or updates the entry
for the connection's own identity; **Channel routing and access** on the card edits it and
adds per-channel overrides. `config/channels/*.yaml` templates are still synced
for existing installs (`channelSquadMap` keyed by channel id, `defaultSquadId`),
but new installs do not need them.

## Multi-Squad Support

A channel instance can route to multiple squads. Inbound routing is deterministic:

1. **Channel mapping** — If the provider channel/chat ID is mapped to a specific squad in `channelSquadMap`, use that squad
2. **Default squad** — Use `defaultSquadId` if set

If neither resolves a squad, routing fails with a configuration error. New UI
and API entries require a default squad. The consultant's later decision to
consult another squad is separate from this initial routing.

## Channel consultants

New channel conversations use `agentTypeId: consultant`, scoped to the resolved
squad. The regular consultant runner adds `channel_respond`, `channel_send`, and
`channel_edit` when the agent has channel-instance context, and omits `ask_human`.
Its added instructions ask clarification questions and send updates in the channel.

Startup migration converts all existing concierge agents to consultants in place,
including dormant and terminated agents. IDs, histories, lifecycle state, channel
context, ownership and resource-generation metadata remain intact. Squad-specific instructions
are merged into consultant instructions. The old runner, built-in role and unused
warm-agent cache are removed; exceptional explicit role grants retain their exact
permissions in a renamed custom role. Agent allocation happens after authorization.

## Credentials and legacy environment variables

Credentials live in the provider's connection (`apps/core/src/services/integrations/channels/`):
the configuration holds the discovered identity, the encrypted credential holds
the secrets, and the transports read both through a per-process snapshot
(`getChannelIntegrationValue` is the compatibility boundary). Before connections,
the same material lived in these secret-store keys / environment variables; on
first boot after upgrading, a complete set is migrated into a connection, and the
keys keep serving as a fallback for one release:

| Variable                  | Now                                                  |
| ------------------------- | ---------------------------------------------------- |
| `DISCORD_BOT_TOKEN`       | Discord credential                                   |
| `DISCORD_APPLICATION_ID`  | Discovered from `/applications/@me`                  |
| `DISCORD_PUBLIC_KEY`      | Discovered from `/applications/@me`                  |
| `DISCORD_GUILD_ID`        | Chosen on the card (server for commands and routing) |
| `SLACK_BOT_TOKEN`         | Slack credential                                     |
| `SLACK_SIGNING_SECRET`    | Slack credential                                     |
| `TELEGRAM_BOT_TOKEN`      | Telegram credential                                  |
| `TELEGRAM_WEBHOOK_SECRET` | Generated by Ficus when a token is saved             |
| `TELEGRAM_BOT_ID`         | Discovered from `getMe`                              |

Platform-managed keys (`FICUS_MANAGED_SECRET_KEYS`) are not migrated or editable;
the transports keep reading them directly.

## Troubleshooting

### Discord: "Invalid signature"

- Verify `DISCORD_PUBLIC_KEY` matches your app's public key
- Ensure the interactions URL uses HTTPS
- Check that the endpoint returns a PONG for Discord's verification ping

### Slack: "Invalid signature"

- Verify `SLACK_SIGNING_SECRET` matches your app's signing secret
- Check that your server's clock is synchronized (signatures have a 5-minute window)

### Telegram: Bot not responding

A bot has one webhook destination. Reusing its token on another Ficus instance
replaces the destination; disabling that copy may delete the shared webhook.
Use separate bots for separate instances.

- Check webhook is registered: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`
- Verify `TELEGRAM_WEBHOOK_SECRET` matches what you set in `setWebhook`
- Verify `TELEGRAM_BOT_ID` matches `botId` in your channel config
- Check logs for webhook verification errors

An HTTP 200 webhook acknowledgement is **not** proof of a visible bot reply.
Telegram replies are separate `sendMessage` API requests. Complete silence,
including no Thinking indicator, can happen at several distinct stages:

1. **No delivery:** the webhook URL, TLS, ingress, or Telegram delivery may fail
   before Ficus receives anything. With authorized access, inspect Telegram's
   `getWebhookInfo` and correlate receipt in Core logs. Do not change webhook
   registration just to diagnose a missing reply.
2. **Rejected delivery:** a disabled integration hides its credentials; a missing
   or mismatched `TELEGRAM_WEBHOOK_SECRET` rejects the webhook with 401. Verify
   the integration is enabled and the secret matches the registered webhook.
3. **Ignored update:** only text messages are processed. Private plain text is
   actionable without `/ficus` or a reply. Group text requires `/ficus` or a
   reply-to-bot; photos without text and other non-message updates are ignored.
4. **Missing bot/connection routing:** the credential settings' numeric
   `TELEGRAM_BOT_ID` must match `providerConfig.botId` on the connection. Missing
   IDs or connections now produce an in-chat configuration error when sending
   is possible; older versions only returned an HTTP acknowledgement here.
5. **Send failure:** a missing/invalid bot token, blocked bot, unavailable chat,
   invalid reply target, or HTTP/network/API error can prevent either Thinking
   or the configuration reply. Check the outgoing API result, not just the
   incoming webhook status. Chat IDs identify reused consultants, while Telegram
   `reply_to_message_id` must be the incoming **message** ID. Older versions used
   the chat ID for Thinking in an existing chat, which could be rejected.

A missing default alone does not establish the cause of a reported silent
message. Before diagnosing an incident, collect the bot identity, deployment,
private/group context, message time and timezone, and authorized receipt/send
logs. Keep bot tokens, webhook secrets, credential-bearing URLs, and private
message contents out of shared diagnostics.

### Commands not appearing

- For Discord: Wait up to 1 hour for global commands, or use `DISCORD_GUILD_ID` for instant guild updates
- For Slack: Reinstall the app to your workspace
- For Telegram: Commands work immediately after webhook is set

### "This server/workspace is not configured"

- Create the routing entry under **Settings → Integrations → provider → Channel routing**
- For YAML-managed entries only, restart Ficus to sync the configuration
- Verify the `guildId`/`teamId`/`botId` matches the platform

## Architecture

The ingress contract is implemented in `apps/core/src/channels/handler.ts`, the Discord gateway, and `apps/core/src/services/channel-access.ts`.

## Notifications

Send high-signal squad notifications to Discord, Slack, or Telegram channels
when work streams complete or need review. Notifications reuse the same bot
configured for slash commands — no separate webhooks needed. Blocked events
require an explicit custom rule.

**Prerequisites:** the channel bot must already be connected ([Discord](#discord),
[Slack](#slack), [Telegram](#telegram)).

### Option 1: Use slash commands (easiest)

From a channel where your bot is present, after authorization for its routed squad:

```
/ficus notify <squad-name>
```

This configures the current channel to receive notifications for its routed squad. Other squads must be configured from Ficus. To
unsubscribe:

```
/ficus unnotify <squad-name>
```

### Option 2: Configure via web UI

1. Go to the squad's **Settings** tab
2. Select the **Notifications** section
3. For each platform (Discord/Slack/Telegram):
   - Select the channel instance (bot)
   - Enter the channel/chat ID where notifications should be sent
4. Click **Save Changes**

### Option 3: Configure via CLI

Set the notification config in squad metadata:

```bash
# Discord - use channel instance ID and Discord channel ID
ficus squad set-meta <squad-id> notifications.discord.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.discord.channelId "<discord-channel-id>"

# Slack - use channel instance ID and Slack channel ID
ficus squad set-meta <squad-id> notifications.slack.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.slack.channelId "<slack-channel-id>"

# Telegram - use channel instance ID and Telegram chat ID
ficus squad set-meta <squad-id> notifications.telegram.instanceId "<instance-id>"
ficus squad set-meta <squad-id> notifications.telegram.channelId "<telegram-chat-id>"
```

To find IDs:

- **Instance ID**: check `config/channels/*.yaml` or the web UI channel instances list
- **Discord channel ID**: right-click the channel → Copy Channel ID (enable Developer Mode in Discord settings)
- **Slack channel ID**: click the channel name → About → scroll to the bottom
- **Telegram chat ID**: use the `/ficus notify` command, or read it from the bot API

### Events that trigger notifications

Configured in `config/notifications/rules.yaml`:

| Event                 | Description                        | Default Channels                        |
| --------------------- | ---------------------------------- | --------------------------------------- |
| `workStream.blocked`  | Agent blocked and needs help       | none (explicit custom rule only)        |
| `workStream.review`   | Work stream ready for human review | push, discord, slack, telegram          |
| `workStream.done`     | Work stream completed              | discord, slack, telegram                |
| `execution.completed` | Agent execution finished           | console                                 |
| `execution.failed`    | Agent execution failed             | push, console, discord, slack, telegram |

### Notification URLs

Set `APP_URL` in `.env` to include clickable links in notifications:

```bash
APP_URL=https://your-domain.com
```

If not set, notifications are sent without URLs.

### Disable notifications

Remove the notification config:

```bash
# Remove Discord notifications for a squad
ficus squad set-meta <squad-id> notifications.discord null

# Or remove all notifications
ficus squad set-meta <squad-id> notifications null
```

## Channel allowlists and denylists

In **Settings → Integrations → Slack/Discord → Channel routing and access**, use
**Allowed channel IDs** to limit the bot to specific channels, or leave it empty
to permit all channels. **Denied channel IDs** always take precedence, even for
linked users and trusted channels. Use exact provider IDs separated by commas or
spaces. Threads inherit their native parent channel's policy, not a Discord
category's policy.

Excluded channels are ignored before help, account linking, history retrieval,
thinking indicators or agent allocation. Delayed consultant replies and squad
notifications also check the current policy. This does not grant squad access:
allowed channels still require a linked user with `chat:send` or explicit trust.
YAML and API fields are `allowedChannelIds` and `deniedChannelIds` (arrays of IDs).

### Discord: slash commands time out but mentions work

Discord sends slash commands through `INTERACTION_CREATE` on the gateway unless an
Interactions Endpoint URL is configured. Ficus handles this event, acknowledges it
before database or agent work, then edits the response with the result. Link
commands receive a private acknowledgement. An unsuccessful acknowledgement
prevents command execution. With an endpoint configured, check its reachability
and signature verification instead; Discord chooses one interaction transport.

### Disable private conversations

Each bot connection has `allowPrivateChats`, defaulting to `true`. The integration's
**Channel routing and access** checkbox persists this setting; channel configuration
YAML can also set `allowPrivateChats: false`. Migration 177 adds the default-enabled
column without changing existing behavior. Inbound DM policy runs before command
parsing, linking, or consultant allocation. Delayed DM consultant responses, edits,
and follow-up sends recheck it. The switch does not clear conversation bindings or
change shared-channel routing. Turning it back on resumes the saved conversations.

Discord slash interactions use the same early callback acknowledgement path for
both the gateway and verified HTTP ingress. HTTP ingress returns an empty 202
because the acknowledgement is sent via Discord's callback endpoint. The native
`BOT_DM` context identifies private interactions when the channel object is omitted.
Public-channel `/ficus squad` requests explain the administrator-managed route and
never change it. Private `/ficus help` lists commands without requiring a squad.
