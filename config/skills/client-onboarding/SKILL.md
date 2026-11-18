---
name: client-onboarding
description: 'End-to-end guide for onboarding a new client — configure secrets, create squads, set up integrations, and verify everything works.'
---

# Client Onboarding

Set up a new Ficus instance in the order below. Each phase names the skill that
holds the detailed steps; read it when you reach that phase. Ask the human the
listed questions before acting on each phase.

Never ask for credentials in chat, even if volunteered. Every credential is entered
by the human in its owning settings form (see the table at the end); saved values
stay hidden and are rotated by replacement.

## Phases

1. **Credentials** (`setup-secrets`). At least one agent-model provider in
   Settings → AI Providers; a GitHub account connection assigned to the squad if
   agents need repositories; OpenAI API services for memory embeddings and voice.
   Ask: which AI providers, API key or account login, private repositories, voice
   and memory search, read-aloud speech.
2. **Squads** (`setup-squad`). Create each squad and note its id for routing:

   ```bash
   ficus squad create "Engineering" -p "Software development and code maintenance" --preset engineering
   ficus squad create "Operations" -p "General operations and support"
   ```

   `engineering` is the only built-in preset; omit `--preset` for an empty squad.

3. **GitHub** (`setup-github-webhooks`). Ask which repositories to watch and
   whether issues route by label or all to one squad. Verify with
   `ficus webhook status github`.
4. **Linear, optional** (`setup-linear-integration`). Ask which Linear teams route
   to which squads. Verify with `ficus webhook status linear`.
5. **Chat channels, optional** (`setup-discord`, `setup-slack`, `setup-telegram`).
   Ask which platforms to connect. For Slack the human enters the **Bot token** and
   **Signing secret** in Settings → Integrations → Slack.
6. **Notifications** (`setup-notifications`). With a channel bot connected,
   `/ficus notify <squad-name>` from the target channel is the quickest route.

## Verification

```bash
ficus squad list
ficus provider-auth list
ficus channel list
```

Then ask the human to log into the web UI, chat with the system manager, run
`/ficus help` in each connected chat platform (or `/help` to the Telegram bot), and
assign a test GitHub or Linear issue to confirm the squad manager receives it.

## Where each setting lives

| Capability                            | Owning settings and input                                                                                                            | When needed                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Bootstrap and personal authentication | Server setup and Account settings                                                                                                    | Required                           |
| Agent-model access                    | Settings → AI Providers; account login or API key                                                                                    | At least one provider              |
| GitHub repository access              | Settings → Integrations → GitHub; connect an account, then assign it to the squad                                                    | If using GitHub                    |
| Direct GitHub/Linear webhooks         | The provider's Webhook delivery panel; generate/replace signing material there                                                       | If direct delivery is configured   |
| Discord bot                           | Settings → Integrations → Discord; **Bot token** only, application identity discovered                                               | If using Discord                   |
| Slack bot                             | Settings → Integrations → Slack; **Bot token** and **Signing secret**                                                                | If using Slack                     |
| Telegram bot                          | Settings → Integrations → Telegram; **Bot token**, with signing secret generated and webhook registered by Core                      | If using Telegram                  |
| Telegram routing                      | Discovered **numeric Bot ID** in the Telegram card, used in the channel instance; this is nonsecret identity, not a credential input | If using Telegram                  |
| Embeddings and voice                  | Settings → Integrations → OpenAI API services; **API key**, separate from agent-model accounts                                       | Recommended                        |
| Read-aloud speech                     | Settings → Integrations → Google Cloud; service-account JSON or server ADC                                                           | Optional                           |
| Push notifications                    | Apple Push and Web Push integration cards                                                                                            | If using push                      |
| Public application URLs               | Server deployment configuration                                                                                                      | Required for public links/delivery |
