# External integrations and BigBrain

## App directory and global switches

Open **Settings → Integrations** to search the app directory. Each card has a global enabled/disabled switch. Expand **Settings** on an enabled card to manage its accounts, app configuration, and webhook delivery. Enabling a card opens its settings; disabling it hides them.

The global switch applies across all squads. Disabling an integration stops new credential access, polling, webhook handling, and workflow output delivery, and reconciles its tools and credentials out of squad sandboxes. Existing account credentials, each account's enabled state, and squad assignments are preserved. Re-enabling restores those selections, subject to normal credential validation. Requests already sent to a provider may finish; disabling does not revoke the external authorization. Use Disconnect for that separate lifecycle action.

Integrations start disabled until explicitly enabled. Saved enable/disable choices are preserved on subsequent upgrades and restarts. Changing a switch requires the provider's global integration write permission. Per-account switches and squad assignment choices still apply beneath the global switch.

The API exposes the effective global state as `enabled` in `GET /api/integrations/catalog`; change it with `PUT /api/integrations/providers/:provider/enabled` and `{ "enabled": false }` (or `true`). State is durable and checked directly across Core processes. Providers with deployment restrictions also expose a safe `availability: { available, reason? }` in the catalog. An unavailable provider remains under Disabled with a visible explanation and refuses enable requests server-side, even if a saved enabled flag exists; saved connection data is not removed. BigBrain availability describes the connected Core deployment, not whether a local binding has been configured. It is managed through Integrations, rather than the generic settings API.

GitHub account setup, account selection, and credential lifecycle are described in [GitHub integrations](github-integrations.md). See [Integration command execution](integration-execution.md) for per-command environments, plugin execution declarations, all-runtime PATH wrappers, and the accepted project-local CLI gap.

Workflows can consume typed integration outputs, and optional squad triggers can create work from issue assignments or review requests. See [Workflows: integration updates and triggers](workflows.md#integration-updates-and-new-work-triggers) and the subscription runtime. GitHub streams with declared subscriptions use their flow consumers; unconverted streams keep the legacy scripts described below.

Ficus's integrations layer provides instance-global external service connections through narrow, provider-neutral capabilities. Each squad selects one pooled connection per provider. BigBrain provides local memory tools. GitHub can publish typed outputs into flow subscriptions while retaining its legacy connection setup. Linear runtime paths remain on their existing adapters; Slack, Discord, and Telegram credentials are connection-scoped (one connection per provider) while the channel runtime still owns delivery and routing.

## Connection lifecycle and BigBrain

Connections belong to an instance-global pool. Authorized global integration
operators manage connection lifecycle; squads select from redacted pooled
connection summaries. Global enablement, account enablement, squad selection,
and agent capability/tool permissions remain independent gates. Many squads can
select one connection; an unassigned squad has no BigBrain access.

Creation and enablement perform live validation outside database locks, then
commit against the connection's material revision. Validation is fresh for 15
minutes; healthy enabled connections are revalidated before expiry. Stale
validation, uncertain health, invalid authentication, unknown versions, or a
missing assignment fail closed. Disable/removal retain authoritative impact
confirmation for assigned squads.

**BigBrain uses an explicitly declared local vault on the self-hosted Core
machine, not an API base and bearer-token form.** See [BigBrain local vault
connections](bigbrain.md) for the implementation contract, upstream pin and
provenance, exact machine boundary, operator setup, CLI selection, tools, failure
states, and removal/release boundary. Hosted and remote-vault configurations are
not supported. Ficus does not automatically capture or export transcripts and
does not replace capture with background summaries or drops. On Ficus Cloud, BigBrain
instead offers [managed shared vaults](bigbrain-shared-vaults.md) that people write in
the BigBrain app and squads read through explicitly selected, read-only tools.

Pool authorization is instance-scoped and provider-subselected:
`integrations:read:<providerKey>` and `integrations:write:<providerKey>`. A bare
instance grant covers every provider; an exact provider grant does not cross
providers. Squad selection separately uses squad-scoped `integrations:read` and
`integrations:write`. A squad grant never exposes pooled private material or
configuration and never authorizes pool lifecycle actions. Admins inherit these
permissions through their implicit `*` grant.

## Future adapter seams

Future migrations may map GitHub and Linear to webhook ingress and memory source capabilities; Slack to ingress, messaging, memory, and notifications; and Discord/Telegram to ingress, messaging, and notifications. Webhook ingress separates synchronous acknowledgement from deferred verified handling so provider deadlines and public URLs can be preserved. Credentials become connection-scoped during those later migrations.

Platform billing and email services (Stripe, SES), AI/model provider authentication, and AMTP remain outside this abstraction. Tenant push configuration is managed through the Apple Push and Web Push integration cards.

## Notion OAuth and CLI

Notion is a catalogued first-party plug-in backed by an instance-global connection pool. Operators connect a workspace once and assign the pooled connection to squads. Hosted authorization uses the central platform broker and its shared OAuth client; tenant Core receives no OAuth client ID or secret. The broker returns the browser to the tenant completion page at `<APP_URL><APP_BASE_PATH>/settings/integrations/oauth/callback`. Self-hosted operators configure their own OAuth application through Settings and register that same exact callback with Notion.

Ficus requests the capabilities configured in the Notion Developer Portal (Read content, Insert content, and Update content). Notion does not accept a dynamic OAuth `scope` parameter, and Ficus does not claim that these portal capabilities can be remotely verified. Page-picker and child-page sharing boundaries still apply.

Notion may omit token expiry. Ficus stores that as a nullable expiry and never invents a refresh schedule. Explicit expiry refresh and reconnect operations rotate the access/refresh pair atomically under a PostgreSQL advisory lease. Identity is validated before installation; a different workspace becomes a distinct unassigned connection. Revocation is queued before local cleanup, and terminal authentication failure requires reconnect.

OAuth client authority is stored with each connection and revocation job. Reconnecting after a deployment-mode change installs the new authority while the retired credential continues to drain through its historical authority. If the historical local OAuth application or broker configuration is unavailable, revocation remains durable and retryable rather than falling back across authorities. Hosted completion receipts retain token-free flow identity, install results, and cleanup obligations so the same browser-held completion handle can safely recover an interrupted install without creating another connection.

Assignment asynchronously projects the pinned `nodejs@24.12.0` runtime and integrity-verified `ntn@0.23.25` CLI. Status is `pending`, `installing`, `ready`, `degraded`, or reconnect-required. Credentials are rendered only into the protected generated sandbox environment and are excluded from APIs, events, status, fingerprints, and toolchain declarations. Unassignment, disablement, and removal deproject protected bindings immediately; normal reconciliation removes the CLI declarations and integration skill without deleting squad-owned toolchain content.

The CLI package is installed from the public npm artifact whose pinned integrity is verified during installation. Tests use a fake provider transport unless the explicitly gated real-CLI integration test is enabled. Rollback consists of unassigning or disabling Notion, allowing deprojection to converge, then removing the pooled connection so remote revocation precedes encrypted-secret cleanup.

## Directory organization and squad access

The global directory shows **Enabled** integrations first and **Disabled** integrations second, alphabetically within each section. Search covers both sections. GitHub, Notion, Linear, and BigBrain have account pools; Discord, Slack, and Telegram have dedicated credential and channel-routing cards. Cloudflare, DigitalOcean, Netlify, Railway, Supabase, and Vercel have deployment credential cards; see [deployment setup](deployments.md).

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
