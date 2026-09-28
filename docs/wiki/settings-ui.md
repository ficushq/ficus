# Settings Page

The Settings page (`/settings`) is the central place to configure user preferences, AI providers, secrets, and all config entities (agent types, squad presets, channels, notification rules).

## Layout

Settings has searchable, permission-aware navigation split between Personal and Administration. Administration is grouped into Work, Access, Configuration, Infrastructure, and Operations. Account is the default personal page, followed by Appearance, App, Notifications, Paired Devices, and Sessions. AI Providers and Integrations use searchable card directories. Workflows, Agent Types, Skills, and Integrations are under Work; AI Providers is under Infrastructure. Enabled integrations appear before disabled ones.

Assistant & Memory is under Infrastructure. Agent Execution is inside Operations → System. The former Features page is retired: its links resolve to Assistant & Memory, or System when targeting the concurrency limit. Old Agent Execution links also resolve to System. The Channels link resolves to Integrations, where Discord, Slack, and Telegram now have their own cards.

The active page is stored in the URL query string (`?section=integrations`). Mobile uses a section picker; desktop uses a scrollable sidebar. Search links include setting targets, so moving a setting does not require hunting through the page.

System Updates reads the current deployment mode and run history from the backend. It does not cache update runs in browser storage or infer runtime mode from a previous run.

Inside Ficus Desktop, System Updates shows the app's native updater instead of the git updater: installed app version, bundled Core commit, check/download progress, and **Restart to update** once an update is ready. When a desktop-managed instance (`flavor.supervisor` is `desktop`) is opened in an ordinary browser, the page only explains that updates come from the desktop app's **Check for Updates…** menu item and stops polling the git updater.

## User Sections

### Notifications

**Push Notifications** — Enable/disable browser push notifications for the current device. Shows a list of all registered devices with the ability to remove individual subscriptions. The current device is labeled.

**Notification Sounds** — Toggle the in-app ping sound that plays when an agent or chat finishes responding.

### Appearance

**Theme** — A grid of preview dots: the built-in themes (Iris, Harbor, Ember, High contrast), the user's own saved theme presets, and the active shared preset if it isn't already one of theirs. Each dot is that theme's color-wheel swatch with its name underneath; the active one is ringed. Picking a built-in deactivates any active preset (kept in the library, not deleted); picking a preset applies it. Below the grid, a **Light/Dark/System** segmented control sets appearance — disabled with an explanatory hint for unified themes (High contrast), which have one appearance. The setup page (**Set up Ficus**) has its own equivalent **Appearance** control. The choice is stored per browser. With no stored choice, browsers use light and Ficus Desktop uses **System**. The **My themes** library below manages presets (new/edit/rename/share/duplicate/export/delete); see [custom themes](theme/custom-themes.md).

### App

**App Installation** — PWA install prompt. Shows platform-appropriate instructions (iOS share sheet, Chrome install button). Displays an "Update Available" banner when a new service worker is ready.

**Offline Cache** — Shows cached API response count, cache size, and last update time. Button to clear the offline cache.

### Account

In passkey mode, Account shows the user profile and controls to add, rename, or remove passkeys; the final passkey cannot be removed. Sign out clears the browser session. Bootstrap/password mode has a limited account view. If authentication is not configured, the page directs the operator to deployment configuration rather than a secret editor.

### Paired Devices and Sessions

**Paired Devices** lists mobile and CLI devices and supports individual revocation. **Sessions** lists active browser sessions and can revoke one or all sessions.

### Access

Users, Roles, System Tokens, and Sign-up appear according to the caller's permissions. They manage accounts and role assignments, scoped automation tokens, and registration policy. Navigation visibility is not a substitute for the backend's permission checks.

## Workspace, Infrastructure, and Operations

### AI Providers

Connect agent-model accounts via API key or supported subscription OAuth. Provider cards show accounts, enable state, and connection status; model-provider enable states control selection and fallback. OpenAI API services for voice and embeddings are configured separately in Integrations.

> **Requires `FICUS_ENCRYPTION_KEY`.** Credentials are written to the encrypted
> secret store, so without the key credential mutations fail with
> `Cannot mutate secrets: FICUS_ENCRYPTION_KEY not configured`. Generate one with
> `echo "FICUS_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env` and restart the
> api + worker. There is no file-based alternative.

Built-in subscription providers include:

| Provider           | OAuth Login      | Description                          |
| ------------------ | ---------------- | ------------------------------------ |
| Anthropic          | Claude Pro/Max   | Claude models (Sonnet, Opus, Haiku)  |
| OpenAI             | ChatGPT Plus/Pro | GPT and o-series models              |
| Google             | Google Cloud     | Gemini models                        |
| GitHub Copilot     | GitHub Copilot   | GitHub Copilot subscription models   |
| Google Antigravity | Antigravity      | Claude, GPT, Gemini via Google Cloud |

**Actions per provider:**

- **Login with [Provider]** — Follow the provider-specific flow. Device login displays a code to enter on the provider site and detects completion automatically. Browser/code flows request the returned authorization code or redirect URL when needed. OpenAI Codex offers device login as the primary option and browser login as an alternative.
- **Set API Key** — Enter an API key directly (password field).
- **Change Key / Re-login** — Update existing credentials.
- **Remove** — Delete stored credentials.

Cards distinguish API-key and OAuth accounts and show whether usable credentials are configured. Available login methods depend on the provider.

### Assistant & Memory

Controls Voice assistant (`ASSISTANT_REALTIME_ENABLED`), Voice dictation (`TRANSCRIPTION_ENABLED`), and Semantic memory search (`EMBEDDINGS_ENABLED`). All three require an enabled, configured **OpenAI API services** integration. This page exposes that same integration connection; feature switches do not change agent-model accounts. Voice dictation defaults on and controls transcription independently of realtime voice. Turning it off hides dictation microphones and shortcuts in chats and question replies, and the transcription endpoint rejects uploads. ChatGPT subscription login under AI Providers does not supply these API credentials.

Message read-aloud uses **Integrations → Google Cloud**, with its own enable switch and service-account JSON or server Application Default Credentials. It is separate from the Realtime Assistant conversation.

### Git and infrastructure credentials

Secrets & Keys has been removed. **Git** shows global author overrides alongside the connected GitHub account's defaults. **Machines** contains the exe.dev account key on self-hosted installations only; hosted tenants cannot view or change it. The bootstrap admin password stays in deployment configuration, while personal authentication is managed under **Account**.

Third-party credentials belong to **Integrations**, including **Apple Push** (APNs) and **Web Push** (VAPID contact address). Saved secrets are never revealed. Existing push credentials and browser signing keys are preserved, and global switches control delivery. New push integrations start disabled; configured installations retain delivery on upgrade.

Initial setup at **/onboarding** includes AI provider selection and authentication, GitHub connection, and first squad creation inline. GitHub connection enables its integration and makes the first account the global default. Browser authorization returns to onboarding; device authorization shows its code inline. Advanced connection settings remain in Settings. Only these three steps count toward setup progress; GitHub can be skipped when repository access is not needed. Voice & memory, team invitations, and chat channels are optional tools, with no completion state or skip actions.

Team invitations stay inline with a list of members and pending invitees. Links created in the current session can be copied individually. Older invitation links cannot be recovered; **Create invite link** replaces the previous link without emailing it. Discord, Slack, and Telegram are all shown as integration cards inline, including independent global enablement, credentials, and channel routing settings. Remote hosts are configured only in Administration settings.

### Workflows

**Administration → Workflows** is the shared preset catalog. Search styles, preview their flows, and create, duplicate, edit, enable, disable, or delete presets. Flow diagrams scroll within their containers. Editing uses the catalog revision to reject stale saves; existing work streams keep their snapshotted definitions.

The page requires `workflows:read`. Create/duplicate, edit/enable/disable, and delete actions require `workflows:create`, `workflows:update`, and `workflows:delete` respectively, respecting each preset's scope. New presets created here are available instance-wide; existing squad and personal presets retain their scope.

Squad settings select a default and alternative presets and record guidance on when to use them. **Manage workflows** links to the catalog when the user has global read access. **Solo** is selected for new squads in the create modal and onboarding. Squad settings require a default when saving; older squads with no saved default are prompted to choose one, with Solo preselected. Previously saved inline flows are preserved and previewable.

### Agent Types

CRUD management for agent type definitions. Each agent type defines a model, system prompt, skills, extensions, and tool allow/deny lists.

**List view** — Sorted alphabetically. Each row shows:

- Name and ID
- Status badges: `Disabled` (gray), `Modified` (yellow, has template drift), `Custom` (blue, admin-created without drift)

**Expand a row** to see the edit form with fields:

- Name, Model, Description
- System Prompt (monospace textarea)
- Skills, Extensions, Tools Allow, Tools Deny (comma-separated lists)

**Actions:**

- **Compare to Template** — Opens the template diff dialog (only shown for template-based items that have been edited by admin).
- **Export YAML** — Copies the YAML representation to clipboard.
- **Enable / Disable** — Toggle availability. Protected agent types (`manager`, `system-manager`, `consultant`) cannot be disabled or deleted.
- **Delete** — Only available for custom (non-template) agent types that aren't protected.
- **+ Add New** — Form to create a new agent type with all fields.

### Squad Presets

CRUD management for squad preset definitions. Similar pattern to Agent Types.

**Fields:**

- Name, Description, Purpose
- Default Agents (comma-separated agent type IDs)
- Manager Instructions (textarea)
- Schedule Templates (JSON array)

**Actions:** Same as Agent Types — Compare to Template, Export YAML, Enable/Disable, Delete (non-template only), + Add New.

### Channel integrations

Discord, Slack, and Telegram each have a card in Integrations. Enable a card, paste the bot token (and Slack signing secret); Ficus validates it, shows the discovered identity, the webhook URL to give the provider, and a **Default squad** picker that creates the routing entry. Saved secret values are never returned to the browser. Disabling an integration stops its transport access without deleting credentials or routes. Existing configured bots retain their enabled state on upgrade.

Channel routing (per-channel overrides) stays in the existing channel system, with CRUD management embedded inside each provider’s card.

**Fields:**

- Name, Provider (discord/slack/telegram — read-only after creation)
- Provider-specific config:
  - Discord: Guild ID
  - Slack: Team ID
  - Telegram: Bot ID
- **Linked Squads** — Either "All squads" (wildcard `*`) or a specific set. Uses pill-style tags with × remove buttons and a dropdown to add more.
- **Default Squad** — Dropdown filtered to linked squads.
- **Channel → Squad Map** — JSON object mapping channel IDs to squad IDs for routing.

**Actions:** Same CRUD pattern — Compare to Template, Export YAML, Enable/Disable, Delete (non-template only), + Add New.

### Notification Rules

Configure which notification channels receive which events.

**Desktop notifications** — Inside a Ficus Desktop build that supports it, a personal switch turns the app's OS alerts for inbox updates on or off. It is stored by the desktop app, not in notification rules, so it does not need `settings:write`.

**Channels section** — Checkboxes to globally enable/disable each channel: `push`, `console`, `discord`, `slack`, `telegram`.

**Rules section** — One card per event type. Each card shows the event name (e.g. `workStream.blocked`) and pill-style channel buttons. Click a pill to toggle that channel for the event. Disabled channels appear dimmed.

Known events:

- `workStream.blocked`, `workStream.review`, `workStream.done`, `workStream.created`, `workStream.updated`
- `inbox.messageReceived`
- `execution.completed`, `execution.failed`

Use the "Add rule for event…" dropdown to create rules for events that don't have one yet. Rules can be removed individually.

**Actions:** Compare to Template, Export YAML, Save (applies all changes at once).

### System

Agent Execution settings, including the instance concurrency override, live here. Maintenance pause safely pauses agent execution and requeues active turns. Read, write, pause, and restart controls follow their respective permissions.

Restart button for the API and worker processes. Shows a warning that active agent executions will be interrupted. Displays restart progress with a spinner: "Sending restart signal…" → "Waiting for server to shut down…" → "Waiting for server to come back online…" → auto-clears.

## Cross-Cutting Features

### Template Diff Dialog

Available on Agent Types, Squad Presets, Channels, and Notification Rules. Opens a modal showing a line-level diff between the current admin-edited config and the original YAML template.

- Red lines = template (removed/changed from)
- Green lines = current (added/changed to)
- Long unchanged sections are collapsed with "⋯ N unchanged lines"
- **Revert to Template** button overwrites all customizations (with confirmation)

The "Compare to Template" link only appears when:

1. The item has a backing YAML template (`hasTemplate` is true)
2. The item was last updated by an admin (`updatedBy === 'admin'`)

### Protected Items

- **Agent types** `manager`, `system-manager`, and `consultant` cannot be disabled or deleted.
- **Template-based items** (any entity with `hasTemplate`) cannot be deleted — only disabled. This prevents losing config that would be recreated from templates on restart anyway.

### YAML Export

Every config entity (agent types, squad presets, channels, notification rules) can be exported as YAML. The "Export YAML" button copies the formatted YAML to the clipboard.

### Workspace Indexing

Workspace indexing settings (include/exclude patterns, reindex button, scan results) are **not** in global settings. They live in the per-squad settings tab at `/squads/:id` in the `WorkspaceIndexingSettings` component.

## Component Locations

| Component                              | Path                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| Settings page                          | `apps/web/src/components/SettingsPage.tsx`                        |
| Git settings (internal SecretsSection) | `apps/web/src/components/settings/SecretsSection.tsx`             |
| AI Providers section                   | `apps/web/src/components/settings/ProviderAuthSection.tsx`        |
| Assistant & Memory                     | `apps/web/src/components/settings/AssistantMemorySection.tsx`     |
| Settings navigation registry           | `apps/web/src/components/settings/settingsSections.ts`            |
| Integrations section                   | `apps/web/src/components/settings/IntegrationsSection.tsx`        |
| Agent Types section                    | `apps/web/src/components/settings/AgentTypesSection.tsx`          |
| Squad Presets section                  | `apps/web/src/components/settings/SquadPresetsSection.tsx`        |
| Channels section                       | `apps/web/src/components/settings/ChannelsSection.tsx`            |
| Notification Rules section             | `apps/web/src/components/settings/NotificationsConfigSection.tsx` |
| Template Diff dialog                   | `apps/web/src/components/settings/TemplateDiffDialog.tsx`         |
| System Updates section                 | `apps/web/src/components/settings/SystemUpdateSection.tsx`        |
| Ficus Desktop updates panel            | `apps/web/src/components/settings/DesktopUpdatePanel.tsx`         |
| Workspace Indexing (squad-level)       | `apps/web/src/components/squads/WorkspaceIndexingSettings.tsx`    |
| Query options                          | `apps/web/src/queryOptions.ts`                                    |
| Query keys                             | `apps/web/src/queryKeys.ts`                                       |
| Secrets API                            | `apps/web/src/api/secrets.ts`                                     |
| Provider Auth API                      | `apps/web/src/api/providerAuth.ts`                                |
| Config API (channels, squads, etc.)    | `apps/web/src/api/config.ts`                                      |

## Squad settings

The squad tab and settings registry is `apps/web/src/lib/squadNavigation.ts`.
Squad settings use eight pages grouped by purpose:

- **General:** avatar, name, description, and discovery by other squads.
- **Instructions:** shared squad context and instructions for individual agent types.
- **Workflows:** default and alternate flows, selection guidance, concurrency limits, auto-parking, and merge policies.
- **Integrations:** enabled apps, account selection, routing, and Git author overrides.
- **Notifications:** where this squad's notifications are delivered; credentials remain in global integration cards.
- **Workspace:** host directory or sandbox lifecycle and logs, plus environment settings. The backend's runtime determines which controls appear.
- **Memory:** embedding configuration, workspace indexing, and memory synchronization.
- **Remote access:** SSH keys, known hosts, SSH configuration, and remote hosts.

Old Policies, Sandbox, Environment, SSH, and Remote hosts links still resolve to the corresponding new page. Search targets for capacity and host directories follow their new owners. Saving a page updates only its fields, so unrelated settings are not overwritten.
