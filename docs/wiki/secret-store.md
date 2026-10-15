# Secret Store

The SecretStore manages application secrets encrypted at rest in the database, replacing direct `process.env` usage. It provides an in-memory cache for fast reads, env-var migration on startup, and change listeners for downstream consumers.

## Overview

```
process.env (seed)          DB (secrets table)           In-memory cache
┌──────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│ ENV vars     │──────▶│ AES-256-GCM         │──────▶│ Map<key, value>  │
│ (initial     │ migrate│ encrypted values    │ load  │ (fast reads)     │
│  values)     │       │ + IV per row        │       │                  │
└──────────────┘       └─────────────────────┘       └──────────────────┘
                              ▲                              │
                         admin edits                    secretStore.get(key)
                         via Settings UI                (cache → env fallback)
```

## How It Works

### Initialization

On startup, the SecretStore:

1. Loads `FICUS_ENCRYPTION_KEY` from the environment (required for DB encryption)
2. Decrypts and loads all secrets from the DB into an in-memory cache
3. Migrates env vars into the DB for any known keys not already stored

If `FICUS_ENCRYPTION_KEY` is not set, the store runs in **read-only env-fallback mode** — `get()` returns `process.env[key]` directly, and `set()`/`delete()` throw errors.

### Reading Secrets

`secretStore.get(key)` checks the in-memory cache first, then falls back to `process.env`. This ensures env vars always work as a last resort, important for tests and gradual migration.

### Writing Secrets

`secretStore.set(key, value, updatedBy)` encrypts the value with AES-256-GCM, upserts into the DB, updates the local cache, and notifies listeners. It then publishes `secret_changed` with the key only. The peer rereads that key from the authoritative DB; secret values never travel through local-events.

### Env Migration

On every startup, the store scans `KNOWN_KEYS` against `process.env`:

- **Key in env but not in DB** → Insert with `updatedBy: 'env'`
- **Key in env and DB with `updatedBy: 'env'`**, value differs → Update (env changed)
- **Key in DB with `updatedBy: 'admin'`** → Never overwrite (admin takes precedence)

This allows env vars to seed initial values while admin-set values always win.

### Change Listeners

Consumers can register callbacks via `secretStore.onChange(listener)`. The listener receives the key and new value (or `undefined` on delete). Used by the K8s sandbox manager to sync auth credentials to pods when secrets change.

### Periodic Refresh

Both API and worker process-local caches call `startPeriodicRefresh()` to reload authoritative DB state every 60 seconds. Key-only local-events invalidation remains the fast path, while the poll self-heals a missed event.

## Encryption

`apps/core/src/services/secrets/crypto.ts`

- **Algorithm**: AES-256-GCM with 16-byte IV and 16-byte auth tag
- **Key**: `FICUS_ENCRYPTION_KEY` env var — either a 64-char hex string (used directly as 32 bytes) or any other string (SHA-256 hashed to derive 32 bytes)
- **Storage**: Each DB row stores hex-encoded `encryptedValue` (ciphertext + auth tag) and `iv`

## Known Keys

The store has a fixed list of known secret keys used across the application:

| Category      | Keys                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| Auth          | `FICUS_PASSWORD`                                                                     |
| AI Providers  | `OPENAI_API_KEY`, `PROVIDER_AUTH_DATA`                                               |
| Git           | `GIT_USER_NAME`, `GIT_USER_EMAIL`                                                    |
| Linear        | `LINEAR_WEBHOOK_SECRET` (legacy; one-time import into integration webhook settings)  |
| Chat (legacy) | `DISCORD_*`, `SLACK_*`, `TELEGRAM_*` — migrated into integration connections on boot |
| Push Notif    | `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`                             |
| Apple Push    | `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV`           |
| Google Cloud  | `GOOGLE_SERVICE_ACCOUNT_JSON`                                                        |

`PROVIDER_AUTH_DATA` is a special JSON blob managed by the [Provider Auth](provider-auth.md) system, not edited directly.

## API Endpoints

The legacy `/api/secrets` endpoints are protected by auth middleware. Integration-owned credentials are omitted and cannot be read or changed here, even when their internal storage still uses a known key listed above. Configure them through their integration cards. The exe.dev infrastructure key is hidden and inaccessible through this API on hosted instances.

| Method   | Endpoint | Description                                   |
| -------- | -------- | --------------------------------------------- |
| `GET`    | `/`      | List all known keys with metadata (no values) |
| `GET`    | `/:key`  | Get a secret's decrypted value                |
| `PUT`    | `/:key`  | Set a secret value                            |
| `DELETE` | `/:key`  | Delete a secret                               |

The list endpoint returns `{ key, isSet, updatedAt, updatedBy }` for every known key, regardless of whether it's set. Values are never included in the list response.

### Save-time validation

GitHub tokens, including the former deployment token, are no longer configured here. Connect an account in Settings → Integrations → GitHub and assign it to a squad. See [GitHub connections](github-integrations.md). Retired token keys are hidden and new writes are rejected; existing stored token values can be explicitly deleted. GitHub webhook secrets are imported into integration-owned storage on startup and are no longer accessible through this API. See the direct delivery setup in the GitHub connections guide.

## Per-agent secrets

A Secret Store key can be exposed to a single agent instead of a squad, for example
to give one operations agent its own API token. Like squad exposures, only key
**names** are stored (`agent_secret_exposures`); values stay here and no API returns
them.

- **Where the value lands.** Only the agent's own sandbox (`agent_<id>`), as the file
  `<private dir>/.ficus/agent-secrets.env` (mode 0600): `/private/.ficus/agent-secrets.env`
  on docker and k8s, `~/.private/.ficus/agent-secrets.env` of the agent's box user on vm.
  The agent's own `bash` tool sources it for each command, so the values are environment
  variables of that command only. Nothing is written to the shared squad workspace, the
  squad box (`squad_bash`), memory or another agent's sandbox. The file name and location
  are fixed; surfaces that browse an agent's private dir hide this file.
- **Subagents** run in their root agent's sandbox and private dir, so they inherit the
  root's per-agent secrets (same trust boundary as the parent). Exposing directly to a
  subagent is refused.
- **Unsupported targets** are refused with an explanation: system managers and
  consultants (their sandboxes are shared) and every agent on the
  [host runtime](host-runtime.md), where all agents are the same OS user.
- **Changes** apply right away: the file is rewritten (or deleted when the last key is
  removed or unset) on every exposure change and when an exposed value changes in the
  Secret Store, and pushed to a running vm box; docker and k8s mount it directly. Every
  sandbox start re-renders it too. Going dormant removes it; termination removes it
  before the private dir is archived, and deleting the agent deletes its exposures.
- **Scope.** Exposures belong to the agent id, so they never follow a reused name or a
  respawned agent, and an exposure recorded for one squad does nothing if the agent is in
  another.
- **Redaction.** Values are Secret Store values, so the existing exact-value redaction
  replaces them in tool output and logs (values shorter than 12 characters are not
  matched). The agent's prompt lists the env var names it holds, never the values.
- **Who can change them.** People with `env:write` on the agent's squad (system scope for
  a squad-less agent), i.e. admins and operators. Agent tokens are refused even when they
  hold `env:write`. Listing needs `env:read`.

| Method   | Endpoint                  | Body              | Description                                    |
| -------- | ------------------------- | ----------------- | ---------------------------------------------- |
| `GET`    | `/api/agents/:id/secrets` |                   | Exposed names, selectable keys, support status |
| `POST`   | `/api/agents/:id/secrets` | `{ keys: [...] }` | Replace the agent's exposed keys               |
| `PUT`    | `/api/agents/:id/secrets` | `{ keys: [...] }` | Add keys                                       |
| `DELETE` | `/api/agents/:id/secrets` | `{ keys: [...] }` | Remove keys (always allowed)                   |

The agent's **Info** tab has a _Per-agent secrets_ section to pick keys, and (with
`secrets:write`) to save a new value to the Secret Store and expose it in one step. The
CLI equivalents are `ficus agent secrets`, `ficus agent expose-secrets` and
`ficus agent unexpose-secrets`.

## Implementation

| File                                       | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `apps/core/src/services/secrets/store.ts`  | `SecretStore` class — cache, sync, migration, change listeners |
| `apps/core/src/services/secrets/crypto.ts` | AES-256-GCM encrypt/decrypt helpers                            |
| `apps/core/src/routes/secrets.ts`          | API routes                                                     |
| `apps/core/src/services/agent/secrets.ts`  | Per-agent exposures and the agent secrets file                 |

Each process owns a process-local singleton accessed via `getSecretStore()` and initializes it before dependent services. The database remains authoritative across both caches.

## Squad GitHub Identity Overrides

Squads can opt into a different GitHub/git identity for sandbox operations by storing non-secret metadata under `metadata.githubIdentity`:

```json
{
  "githubIdentity": {
    "gitUserName": "Squad Bot",
    "gitUserEmail": "squad-bot@example.com"
  }
}
```

GitHub accounts and webhook signing are configured through **Settings → Integrations → GitHub**.
Choose accounts in the squad's integration settings. Set non-secret commit author overrides with:

```bash
ficus squad set-meta <squad-id> githubIdentity '{"gitUserName":"Squad Bot","gitUserEmail":"squad-bot@example.com"}'
```

Commit author identity can use `GIT_USER_NAME`, `GIT_USER_EMAIL`, and host git config fallbacks. Repository credentials always come from an assigned [GitHub integration connection](github-integrations.md). Legacy `GH_TOKEN`, `GITHUB_TOKEN`, and token-key metadata overrides are no longer consumed.
