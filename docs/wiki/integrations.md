# External integrations and Bigbrain

## App directory and global switches

Open **Settings → Integrations** to search the app directory. Each card has a global enabled/disabled switch. Expand **Settings** on an enabled card to manage its accounts, app configuration, and webhook delivery. Enabling a card opens its settings; disabling it hides them.

The global switch applies across all squads. Disabling an integration stops new credential access, polling, webhook handling, workflow output delivery, and conversation exports, and reconciles its tools and credentials out of squad sandboxes. Existing account credentials, each account's enabled state, and squad assignments are preserved. Re-enabling restores those selections, subject to normal credential validation. Requests already sent to a provider may finish; disabling does not revoke the external authorization. Use Disconnect for that separate lifecycle action.

Integrations start disabled until explicitly enabled. Saved enable/disable choices are preserved on subsequent upgrades and restarts. Changing a switch requires the provider's global integration write permission. Per-account switches and squad assignment choices still apply beneath the global switch.

The API exposes the effective global state as `enabled` in `GET /api/integrations/catalog`; change it with `PUT /api/integrations/providers/:provider/enabled` and `{ "enabled": false }` (or `true`). State is durable and checked directly across Core processes. It is managed through Integrations, rather than the generic settings API.

GitHub account setup, account selection, and credential lifecycle are described in [GitHub integrations](github-integrations.md).

Workflows can consume typed integration outputs, and optional squad triggers can create work from issue assignments or review requests. See [Workflows: integration updates and triggers](workflows.md#integration-updates-and-new-work-triggers) and the subscription runtime. GitHub streams with declared subscriptions use their flow consumers; unconverted streams keep the legacy scripts described below.

Ficus's integrations layer provides instance-global external service connections through narrow, provider-neutral capabilities. Each squad selects one pooled connection per provider. Bigbrain is the first provider. GitHub can publish typed outputs into flow subscriptions while retaining its legacy connection setup. Linear runtime paths remain on their existing adapters; Slack, Discord, and Telegram credentials are connection-scoped (one connection per provider) while the channel runtime still owns delivery and routing.

## Clean-room provenance

The protocol behavior used for this connector was independently described from observable behavior at `elsehow/bigbrain@5681d62beebad7812d901ed25ce911241e277c13`. No repository-wide root license was observable, so Ficus treats that source as unavailable for reuse. This implementation does not copy or adapt its source, tests, comments, scripts, documentation, or prose, and does not depend on that repository.

## Connection lifecycle

Connections belong to an instance-global pool. An authorized Operator or Admin manages the pool from Settings → Integrations using an HTTPS API base and bearer credential. Squad Settings → Integrations reuses that lifecycle surface when the viewer has global access and additionally provides a selector for the connection that squad uses. Many squads may select one connection; a squad with no selection has no integration for that provider.

The credential is encrypted by Ficus's secret store. Full pool responses contain safe configuration and `credentialConfigured` status, never a credential value or reference. The squad selector receives only connection ID, provider, display name, enabled state, and health state.

Creation and enablement perform live validation. Provider I/O occurs outside database locks, followed by a material-revision compare-and-set. Validation remains fresh for 15 minutes. Healthy connections are scheduled for revalidation two minutes before expiry so the worker's one-minute polling interval does not create a recurring authorization gap. Failed validations retain their retry backoff. Changed credentials/configuration, stale validation, uncertain health, invalid authentication, unknown versions, or a missing assignment fail closed.

Bigbrain scopes:

- `vault:read`: search, note retrieval, and memory retrieval
- `inbox:write`: Markdown drop and consented conversation export

Safely provide a credential to the CLI through stdin, never an argument:

```sh
printf '%s' "$BIGBRAIN_TOKEN" | ficus integration create bigbrain \
  --api-base https://brain.example --credential-stdin

ficus integration list --provider bigbrain
ficus integration assign bigbrain --squad "$SQUAD_ID" --connection "$CONNECTION_ID"
# Remove the squad binding without deleting the pooled connection:
ficus integration unassign bigbrain --squad "$SQUAD_ID"
```

Agent tools require both a version-1 integration policy and explicit `tools.allow` entries:

```yaml
integrations:
  version: 1
  allow:
    bigbrain: [agent_tools, conversation_export]
tools:
  allow:
    - bigbrain_search
    - bigbrain_get_note
    - bigbrain_get_memory
    - bigbrain_drop_markdown
```

Absence is denial. Enabling a connection does not expose tools or consent any conversation. `bigbrain_drop_markdown` is a consent-independent outbound channel: once an Operator or Admin enables both `agent_tools` policy and that tool, the agent can send arbitrary Markdown it can access to Bigbrain. Conversation-export consent does not govern this tool.

Pool lifecycle authorization is instance-scoped and provider-subselected: `integrations:read:<providerKey>` and `integrations:write:<providerKey>`. A bare instance `integrations:read` or `integrations:write` grant covers every provider, while an exact provider grant does not cross providers. The squad selector separately uses squad-scoped `integrations:read` and `integrations:write`. A squad-scoped grant never reveals pooled credential or configuration details and never authorizes lifecycle actions. Admins inherit these permissions through the Admin role's implicit `*` permission.

## Conversation export and consent

Conversation export is default-off. A human with `integrations:export` must explicitly consent for a specific top-level squad conversation and connection. Consent records the user, time, connection, policy/projection versions, and the current message high-water, so export is prospective and never backfills earlier history.

Only server-attributed user/assistant text from complete executions is projected. Ficus excludes system/developer/internal and inbox events, hidden reasoning, tool calls and results, attachments/images/binary data, deleted/redacted records, subagents, unrelated sessions, uncertain provenance, and message metadata content. Text passes conservative credential redaction before encoding.

Revocation immediately prevents future creation or delivery. It does not delete data already delivered remotely. Ficus makes no remote-deletion promise.

The encrypted ordered outbox stores stable payload bytes and an idempotency key. Batches contain at most 100 complete records and 256 KiB. Ambiguous retries reuse identical bytes. The cursor advances only in the transaction that marks a 2xx delivery successful; acknowledged payload ciphertext is scrubbed. Retry/dead-letter records and audits contain counts, bytes, identifiers, and sanitized codes only.

## Operations

- Before disabling, rotating, or removing a connection, inspect the authoritative usage confirmation. It names/counts affected squads. Disable and rotation preserve assignments and consents but suspend runtime use until the connection is re-enabled; removal cascades all assignments.
- Rotate a suspected credential, which disables and invalidates the connection, then validate and explicitly enable it again. The blast radius includes every assigned squad.
- A 401 invalidates authentication and disables runtime capabilities. Missing scope, timeout, and availability failures suspend capabilities pending successful validation.
- Inspect health, validation expiry, retry/dead-letter counts, and sanitized error codes. Provider response bodies and exported content must never appear in logs or audits.
- For credential leakage, disable the connection, revoke the remote credential, rotate it in Ficus, revoke affected export consents, and review content-free audit identifiers.

## Migration and rollback

The migration preserves every existing connection row, credential reference, consent, cursor, and encrypted batch. It creates an assignment only from each squad's previously enabled connection, so effective exports continue without credential entry, backfill, or a destination blip. Duplicate display names are disambiguated for the global pool. The old nullable connection `squad_id` remains only as rollout provenance; runtime resolution never uses it.

Ficus's migrator is forward-only and does not provide a schema-down command. A safe application rollback retains the additive assignment table and nullable legacy provenance. Before rolling application code back, disable every Bigbrain connection, revoke active export consents, stop the export and revalidation workers, and verify that no batch remains in `pending`, `processing`, or `retry_wait`. After the older application is running, verify existing provider paths and confirm the integration workers are absent. Destructive removal requires a separately reviewed forward migration. Neither application rollback nor consent revocation removes data already delivered remotely.

## Future adapter seams

Future migrations may map GitHub and Linear to webhook ingress and memory source capabilities; Slack to ingress, messaging, memory, and notifications; and Discord/Telegram to ingress, messaging, and notifications. Webhook ingress separates synchronous acknowledgement from deferred verified handling so provider deadlines and public URLs can be preserved. Credentials become connection-scoped during those later migrations.

Platform billing and email services (Stripe, SES), AI/model provider authentication, and AMTP remain outside this abstraction. Tenant push configuration is managed through the Apple Push and Web Push integration cards.

## Notion OAuth and CLI

Notion is a catalogued first-party plug-in backed by an instance-global connection pool. Operators connect a workspace once and assign the pooled connection to squads. Hosted authorization uses the central platform broker and its shared OAuth client; tenant Core receives no OAuth client ID or secret. The broker returns the browser to the tenant completion page at `<APP_URL><APP_BASE_PATH>/settings/integrations/oauth/callback`. Self-hosted operators configure their own OAuth application through Settings and register that same exact callback with Notion.

Ficus requests the capabilities configured in the Notion Developer Portal (Read content, Insert content, and Update content). Notion does not accept a dynamic OAuth `scope` parameter, and Ficus does not claim that these portal capabilities can be remotely verified. Page-picker and child-page sharing boundaries still apply.

Notion may omit token expiry. Ficus stores that as a nullable expiry and never invents a refresh schedule. Explicit expiry refresh and reconnect operations rotate the access/refresh pair atomically under a PostgreSQL advisory lease. Identity is validated before installation; a different workspace becomes a distinct unassigned connection. Revocation is queued before local cleanup, and terminal authentication failure requires reconnect.

OAuth client authority is stored with each connection and revocation job. Reconnecting after a deployment-mode change installs the new authority while the retired credential continues to drain through its historical authority. If the historical local OAuth application or broker configuration is unavailable, revocation remains durable and retryable rather than falling back across authorities. Hosted completion receipts retain token-free flow identity, install results, and cleanup obligations so the same browser-held completion handle can safely recover an interrupted install without creating another connection.

Assignment asynchronously projects the pinned `nodejs@24.12.0` runtime and integrity-verified `ntn@0.22.10` CLI. Status is `pending`, `installing`, `ready`, `degraded`, or reconnect-required. Credentials are rendered only into the protected generated sandbox environment and are excluded from APIs, events, status, fingerprints, and toolchain declarations. Unassignment, disablement, and removal deproject protected bindings immediately; normal reconciliation removes the CLI declarations and integration skill without deleting squad-owned toolchain content.

The CLI package is installed from the public npm artifact whose pinned integrity is verified during installation. Tests use a fake provider transport unless the explicitly gated real-CLI integration test is enabled. Rollback consists of unassigning or disabling Notion, allowing deprojection to converge, then removing the pooled connection so remote revocation precedes encrypted-secret cleanup.

## Directory organization and squad access

The global directory shows **Enabled** integrations first and **Disabled** integrations second, alphabetically within each section. Search covers both sections. GitHub, Notion, Linear, and Bigbrain have account pools; Discord, Slack, and Telegram have dedicated credential and channel-routing cards. Cloudflare, DigitalOcean, Netlify, Railway, Supabase, and Vercel have deployment credential cards; see [deployment setup](deployments.md).

Squad settings show only globally enabled integrations that support account assignments. Each squad can disable its integration without losing its selected accounts. Re-enabling restores its choice. Global credentials are edited only on the global directory, with integration write permission; squad account choices require squad integration write permission.

The first connected GitHub account becomes the **global default**. Squads inherit it unless they select their own accounts or disable GitHub. A global administrator can choose another default account. Explicit squad overrides remain intact. Removing the default never silently substitutes another GitHub identity; select a new default or reconnect instead. New squads receive the inherited assignment before their manager starts.

See [GitHub](github-integrations.md), [Linear](linear-integrations.md), and [Channels](channels.md) for setup. Channel credentials are integration connections (one per provider; see `apps/core/src/services/integrations/channels/`), validated and re-validated like any other connection, while the channel runtime continues to own message delivery and routing. Existing configured channel integrations retain their enabled state on upgrade; new ones default to disabled.

## Google Cloud speech

Use **Settings → Integrations → Google Cloud** to enable message read-aloud and save a service-account JSON key. Enable Google Cloud Text-to-Speech in that key’s project. Saved JSON remains encrypted and hidden; enter replacement JSON to rotate it. Invalid service-account JSON is rejected before saving. Rotation applies to new speech requests without restarting Ficus, while ongoing speech can finish with its existing client.

Existing explicit Google credentials are preserved and enabled on upgrade; new installations start disabled. Administrators can also use Google Application Default Credentials on the server; an existing `GOOGLE_APPLICATION_CREDENTIALS` file configuration is recognized on upgrade. For other ADC environments, explicitly enable the card. The global switch gates speech even when ADC is available. This integration serves Text-to-Speech; transcription and embeddings currently use the separate OpenAI API services integration.

## OpenAI API services versus agent models

**Settings → Integrations → OpenAI API services** configures realtime voice, transcription, and memory embeddings. Its API key is encrypted separately from the agent-provider account store. Saving it neither registers an OpenAI model account nor enables that provider for agent fallback. Configure OpenAI/ChatGPT agent access separately in **AI Providers**; those credentials are not automatically reused by API services. You may enable either side or both with different keys.

Existing standalone service keys migrate enabled; fresh integrations start disabled. Disabling API services gates new voice/transcription/embedding requests without deleting the key or changing model-provider enable state. The Memory page’s embeddings setting still applies as well. Rotation applies to subsequent API requests without restarting Ficus.

For compatibility, a server-level `OPENAI_API_KEY` environment variable still has its historical provider-discovery behavior. For services-only access, save the key in this integration card instead of exporting it into the server’s environment; existing environment-authenticated model access can also be disabled separately in AI Providers. No secrets or provider accounts are silently deleted during this move.

### Git commit author defaults

With GitHub connected and enabled, Ficus loads the selected account's public name and email for Git commits. If the profile has no public name, it uses the login; if the email is private, it uses the account's GitHub noreply address. Settings → Git shows these defaults beside the global author overrides, and squad GitHub settings show the squad account's defaults and the inherited values. Clearing an override restores inheritance. The priority for each field is squad override, global override, connected GitHub account, then host Git configuration.

Profile details are cached briefly; disabling or changing an account still checks the live integration assignment. New sandbox executions receive the resolved identity. Existing running processes retain their environment until restarted.

## Push delivery

**Apple Push** configures APNs signing credentials for native iOS notifications and Live Activities. Enable it and supply the .p8 key, key ID, team ID, and app bundle ID. Production is the default environment. Hosted platform credentials are protected and cannot be replaced from a tenant's card.

**Web Push** controls browser and installed web app notifications. Ficus keeps existing VAPID signing keys so browser subscriptions survive this move. Its contact address accepts a `mailto:` email or HTTPS URL. Each user subscribes in Personal → Notifications. Disabling delivery preserves keys and registrations; enabling resumes delivery. Fresh installations start disabled, while existing configured push installations stay enabled on upgrade.

### Configuration status

Global integration cards show configuration status even with Settings collapsed. **Setup required** lists missing required credentials or asks you to connect an account. **Needs attention** identifies accounts that are disabled, need authentication/validation, or have no healthy connection. **Configured** means the local requirements and known connection checks pass; it is separate from the global enable switch and does not guarantee a third-party service is reachable at every instant.

Required fields are marked in the form. Saved secrets do not need to be re-entered when editing other settings. The API can save partial setup, which remains marked incomplete, but rejects empty replacements for required fields before writing changes. Optional webhook, custom-app, and routing settings are not universal requirements. Managed credentials and Google ADC configuration satisfy the corresponding setup requirements.

Web Push requires a valid `mailto:` contact or HTTPS contact URL before subscribing or delivering notifications. Enabling an integration opens its settings and scrolls to its new position in the Enabled group; reduced-motion preferences are respected.

## Assistant and memory features

**Settings → Assistant & Memory** controls realtime assistant sessions and automatic
semantic memory indexing independently. Both choices default to on, but require an
enabled, configured **OpenAI API services** integration before they can run. The
page distinguishes selected features from features that are ready. Onboarding
includes these recommended features and the same inline API-key setup; visiting
onboarding does not enable an integration or save credentials automatically.

Use **Save and enable** to save the key in the integration credential store and
enable API services. This is the same connection shown in Integrations, not a
second credential. Ficus's ChatGPT subscription login in AI Providers does not
supply an API-services key. API-service usage is billed to the supplied API account.

The `ASSISTANT_REALTIME_ENABLED` setting gates new realtime sessions. Turning it
off leaves transcription and system-manager text chat available; it does not
terminate an already established realtime session. `EMBEDDINGS_ENABLED` controls
automatic indexing without deleting saved memory. Disabling the OpenAI API
services integration makes all dependent API services unavailable, while retaining
the feature selections and credentials.

The global **Maximum active agents** setting now lives in **Settings → System**,
alongside maintenance and restart controls. **Logs** contains server logs. Previous
Agent Execution settings links continue to resolve to System.
