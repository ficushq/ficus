---
name: setup-slack
description: 'Set up Slack app integration — create the Slack app from a manifest, enter its credentials, and create the channel instance.'
---

# Setting Up Slack Integration

Slack integration gives users `/ficus` slash commands and thread conversations in
their workspace; a consultant answers. Every step is instance-level. Squad routing
lives in the channel instance (step 3).

Check what exists first with `ficus channel list`. If Slack is already set up, you
only need to change the channel instance's routing (`ficus channel update <id>
--default-squad` or `--channel-squad-map`).

The human performs the Slack portal steps and enters the credentials. Never ask for
tokens in chat, and never read, print, log or commit them. Channel plugins have no
command execution, so no channel token belongs in a sandbox or `integration exec`
command. Use the exact webhook URL shown in **Settings → Integrations → Slack**,
including any public base path; never infer an API hostname from `APP_URL`. Saved
changes reconcile without a manual restart.

## 1. Create the Slack app

At [Slack API](https://api.slack.com/apps): **Create New App → From an app
manifest**, choose the workspace, and paste this manifest with each
`YOUR_WEBHOOK_URL` replaced by the URL from the Slack card:

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
      url: YOUR_WEBHOOK_URL
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
    request_url: YOUR_WEBHOOK_URL
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

Review, **Create**, then **Install App → Install to Workspace**. If the human builds
the app by hand instead, the manifest lists the slash command, bot scopes and bot
events to configure.

## 2. Configure the integration

The human enters these in **Settings → Integrations → Slack**, then saves, validates
and enables the connection and checks **Connection status**:

- **Signing secret**: Basic Information → App Credentials → Signing Secret.
- **Bot token**: OAuth & Permissions → Bot User OAuth Token (starts with `xoxb-`).

## 3. Channel instance

The Team ID is the `T...` segment of the browser URL
(`https://app.slack.com/client/T0123ABCD/...`).

```bash
ficus channel create \
  --id "client-slack" \
  --name "Client Slack Workspace" \
  --provider slack \
  --config '{"teamId": "T0123ABCD"}' \
  --default-squad "<squad-uuid>"

# Optional: route specific Slack channels (channel name → About) to other squads.
# Replaces the whole map; unmapped channels use the default squad.
ficus channel update client-slack \
  --channel-squad-map '{"<slack-channel-id>": "<squad-uuid>"}'
```

## 4. Verify

Ask the human to run `/ficus help`, `/ficus status` and `/ficus ask How are you?`,
then reply to the bot in its thread. A slash command inside a thread starts a new
conversation; replying to the bot continues the current one.

| Problem                       | Check                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Slash command errors          | Connection status; if signing was rejected, have the human replace the Signing secret in the Slack card |
| Events URL fails verification | The exact URL from the card; Core reachability                                                          |
| Thread replies ignored        | Event subscriptions enabled with the `message.*` events                                                 |
| `dispatch_failed`             | Core did not answer within 3 seconds; check its health and logs                                         |
| Bot cannot post               | Invite the bot to the channel, or keep the `chat:write.public` scope                                    |
