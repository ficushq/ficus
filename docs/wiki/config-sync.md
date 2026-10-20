# Config Sync

Config sync bridges bundled configuration files and database records. On API startup, it loads templates from `config/`, updates fields still controlled by those templates, and preserves admin overrides. Skills use Markdown and support files; the other domains use YAML.

## Domains and startup order

`apps/core/src/services/config-sync/index.ts` registers nine domains in this order:

| Domain          | Synchronizer        | Source                                           | DB table               |
| --------------- | ------------------- | ------------------------------------------------ | ---------------------- |
| Roles           | `RoleSync`          | `config/roles/defaults.yaml`                     | `roles`                |
| Skills          | `SkillSync`         | `config/skills/<id>/SKILL.md` and support files  | `skills`               |
| Shared prompts  | `SharedPromptSync`  | `config/agent-types/shared/*.md`               | `shared_prompts`       |
| Model tiers     | `ModelTierSync`     | `config/model-tiers/`                            | `model_tiers`          |
| Agent types     | `AgentTypeSync`     | `config/agent-types/`                            | `agent_types`          |
| Squad presets   | `SquadPresetSync`   | `config/squad-presets/`                          | `squad_presets`        |
| Workflows       | `WorkflowSync`      | `config/workflows/`                              | `workflows`            |
| Channels        | `ChannelSync`       | `config/channels/`                               | `channel_instances`    |
| Notifications   | `NotificationSync`  | `config/notifications/`                          | `notification_config`  |

The eight non-role domains extend `ConfigSync`. Roles have separate synchronization rules described below. `syncAllConfig()` runs during API startup; the worker reads the resulting database configuration and does not run startup synchronization.

```text
Bundled files                     Database
config/<domain>/ ─── startup ───▶ template snapshot + effective fields
                                           ▲
                                      API/UI edits
                                  preserve overridden fields
```

## Field overrides

The eight `ConfigSync` domains track:

| Column               | Purpose                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `yamlTemplate`       | Snapshot of the parsed source record at the latest sync, including Markdown-derived records |
| `yamlFieldOverrides` | Field keys whose database values differ from the template                                   |
| `disabled`           | Domain enable/disable state, managed separately from template content                       |

For most domains, overrides apply to **top-level fields**. Editing one field preserves that field while other fields continue to receive bundled updates. Nested objects and arrays are compared as field values, rather than merged recursively. Notification rules and channels use more granular keys: `rules.<rule-key>` and `channels.<channel-name>`.

The base class retains compatibility with older `updatedBy` / `yamlDrift` columns, but whole-record admin ownership is not the current model for these eight domains.

### Startup behavior

- **No existing record:** insert the parsed record, its template snapshot, and an empty override list.
- **Existing record:** apply the new template, retain stored override fields from the current record, store the new snapshot, and recompute overrides. An override that now equals the new template is cleared.
- **Source record removed:** delete a previously templated record only when its override list is empty. Preserve records with overrides and custom records without a template.

Field comparisons use deep JSON equality with sorted object keys. API edits recompute overrides against the stored template. A full revert restores the template fields and clears all overrides; supported field-revert endpoints restore selected keys. Reverting requires a stored template.

### Roles

`RoleSync` reads `config/roles/defaults.yaml` and matches roles by slug. It inserts missing defaults and updates permissions, `readOnly`, and `appliesTo` when those values change. Admin changes to non-read-only roles are preserved. Roles marked `readOnly` in YAML always reconcile those fields from YAML, including after an admin edit. This synchronizer does not delete roles that disappear from the file and does not use `yamlFieldOverrides`.

## Domain details

### Skills and model tiers

`SkillSync` reads each bundled skill's `SKILL.md` and support files, parses its metadata, and invalidates the `Skill` cache after sync. Hidden and `example-` directories are skipped. `ModelTierSync` loads model-tier definitions before agent types so model selection can reference them.

### Shared prompts

`SharedPromptSync` reads each Markdown file under `config/agent-types/shared/` into its own `shared_prompts` record, following the same template snapshot / `yamlFieldOverrides` / disable / revert model as skills. It runs after `SkillSync` and before `ModelTierSync`, so includes exist before agent types are synced. Agent type sync validates that every ID an agent type lists in its `includes` actually exists.

### Agent types

`AgentTypeSync` parses agent definitions, including model selection, system prompts, scopes, integration policy, skills, extensions, tool allow/deny lists, and heartbeat configuration. An agent type's `includes:` list is stored as an ordered list of shared prompt IDs — tracked as a template field like any other, so admins can override or revert it — rather than being appended into the system prompt at sync time; every runner composes its own prompt with its enabled includes, in list order and joined by blank lines, when it builds the agent's prompt at runtime. A one-time repair splits rows edited before this change, where the stored prompt override still ends with the include text it once had appended, back into a bare prompt plus an `includes` override; it logs any row it cannot split cleanly. Sync invalidates the `AgentType` cache.

### Squad presets

`SquadPresetSync` parses squad definitions, including purpose, persistent members, manager context, workflow defaults and recommendations, and schedule templates. Sync invalidates only the preset catalog cache. Existing squads are detached: preset edits, disabling, and deletion never reconcile their members, prompts, work preferences, or schedules.

Schedule templates support cron/interval actions such as inbox messages, agent spawning, and work stream creation. Cron schedules use five-field expressions: `15 * * * *` runs hourly at minute 15. See [Workflows, flows, and squads](workflows.md) for the distinction between squad defaults and lazily created workflow participants.

### Workflows

`WorkflowSync` validates each preset with `workflowPresetSchema` and stores its ID, description, scope, and flow definition. Presets default to instance scope. Selecting a style governs participation and delivery for a work stream; see [Workflows, flows, and squads](workflows.md).

### Channels

`ChannelSync` parses channel routing and access policies and validates provider configuration. Consultants are created on demand after ingress authorization, never during config sync.

### Notifications

`NotificationSync` uses a single record with ID `default`. It loads ordered rules (`event`, optional `match`, and `channels`) plus channel enablement. Stable rule identities allow per-rule overrides to survive template updates. After sync it updates the in-memory notification service. See [Notifications](notifications.md).

## Implementation and API

`apps/core/src/services/config-sync/ConfigSync.ts` supplies loading, synchronization, diffing, full/field reversion, override recomputation, and enable/disable helpers. Subclasses define their table/columns, parsing, record conversion, comparison, export, and optional `afterSync()` behavior. The base class maps Drizzle column names to JavaScript property names with a cached `jsKey()` helper.

Template-diff responses include `{ hasDrift, current, template, fieldOverrides }`. Routes and permissions vary by domain; for example:

- `GET /api/agent-types/:id/template-diff`
- `POST /api/agent-types/:id/revert-to-template`
- `POST /api/agent-types/:id/revert-template-fields`
- `GET /api/workflows/:id/template-diff`
- `POST /api/workflows/:id/revert` (requires the current revision)

Use the domain's current routes or CLI help instead of assuming every domain exposes identical CRUD or revert endpoints. Template snapshots keep diffs and reverts independent of filesystem reads. Webhook shell actions remain file-only and are outside these synchronized domains.
