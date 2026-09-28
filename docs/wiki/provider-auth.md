# Provider Auth

Provider auth manages AI provider credentials (API keys and OAuth tokens) so that agent sessions can authenticate with providers like Anthropic, OpenAI, and Google. Credentials are stored encrypted in the [Secret Store](secret-store.md) and exposed through a per-provider REST API.

## Overview

```
Settings UI                    Provider Auth API              SecretStore
┌──────────────┐          ┌─────────────────────┐       ┌──────────────────┐
│ API Key form │──PUT────▶│ /provider-auth/:id   │──────▶│ PROVIDER_AUTH_   │
│              │          │                     │       │ DATA (JSON blob) │
│ OAuth button │──POST───▶│ /:id/oauth/start    │       │                  │
│              │          │   ↓ returns authUrl  │       │                  │
│ Paste code   │──POST───▶│ /:id/oauth/callback │──────▶│                  │
└──────────────┘          └─────────────────────┘       └──────────────────┘
                                    │
                                    ▼
                          ┌─────────────────────┐
                          │ Agent sessions use   │
                          │ AuthStorage to read  │
                          │ credentials at       │
                          │ execution time       │
                          └─────────────────────┘
```

## Two Auth Methods

### API Keys

The simple path — the user enters an API key in the Settings UI, and it's stored directly:

```
PUT /api/provider-auth/openai  { "key": "sk-..." }
```

### OAuth

For providers that support OAuth (discovered via `pi-ai`'s `getOAuthProviders()`):

1. **Start**: `POST /api/provider-auth/:provider/oauth/start`
   - Server calls `AuthStorage.login()` from `pi-coding-agent`, which initiates the OAuth flow
   - The `onAuth` callback captures the authorization URL
   - Returns `{ authUrl, instructions, status: 'started' }` to the frontend

2. **User authenticates**: Opens `authUrl` in browser, grants access, receives a code

3. **Callback**: `POST /api/provider-auth/:provider/oauth/callback` with `{ code }`
   - Resolves a pending promise that the `onPrompt`/`onManualCodeInput` callback is awaiting
   - The server-side flow exchanges the code for tokens and stores them
   - Returns `{ status: 'authenticated' }`

Pending OAuth flows are tracked in-memory with a 10-minute timeout. The flow is stateful — `start` creates a background promise chain, and `callback` resolves it.

## Storage

All provider credentials are stored as a single JSON blob in the SecretStore under the key `PROVIDER_AUTH_DATA`. The blob is a map of provider ID → credential object:

```json
{
  "anthropic": { "type": "oauth", "accessToken": "...", "refreshToken": "...", ... },
  "openai": { "type": "api_key", "key": "sk-..." }
}
```

Credentials are managed exclusively through the Settings UI, the CLI (`ficus provider-auth`), and the API below; there is no file-based credential store.

## SecretStoreAuthBackend

`apps/core/src/services/agent/auth-backend.ts`

Bridges `pi-coding-agent`'s `AuthStorageBackend` interface to the SecretStore. Implements `withLock` and `withLockAsync` for atomic read-modify-write of the JSON blob.

The process-singleton `ModelRuntime` (see `getModelRuntime()`) reads credentials through this backend. With no `PROVIDER_AUTH_DATA` secret yet, the store is simply empty until a credential is added via the UI, CLI, or API.

## API Endpoints

All under `/api/provider-auth`, protected by auth middleware.

| Method   | Endpoint                    | Description                               |
| -------- | --------------------------- | ----------------------------------------- |
| `GET`    | `/`                         | List providers with auth status (no keys) |
| `GET`    | `/oauth/providers`          | List available OAuth providers            |
| `GET`    | `/:provider`                | Check if a provider has credentials       |
| `PUT`    | `/:provider`                | Set API key for a provider                |
| `DELETE` | `/:provider`                | Remove auth for a provider                |
| `POST`   | `/:provider/oauth/start`    | Start OAuth flow, returns auth URL        |
| `POST`   | `/:provider/oauth/callback` | Complete OAuth flow with auth code        |
| `GET`    | `/:provider/oauth/status`   | Check status of pending OAuth flow        |

Provider health (all require `provider-auth:write`):

| Method | Endpoint                                      | Description                            |
| ------ | --------------------------------------------- | -------------------------------------- |
| `POST` | `/:provider/health/reset`                     | Clear the provider's and all accounts' |
| `POST` | `/:provider/accounts/:accountId/health/reset` | Clear one account's record             |

Both return the refreshed provider summary, and `404` for an unknown provider or account.

### Resetting provider health

When a provider returns a rate limit or plan-window exhaustion, Ficus records a cooldown and stops
routing to it until `retryAt`. That timestamp is only as good as what the provider told us: the
error often carries no reset time at all (Ficus then applies a default window — 30 minutes for a plan
limit), and some providers reset their window earlier than they announced. Waiting out a window
that is already over costs real throughput.

Codex reports a usage limit in two different shapes, and both are ambiguous between a transient
throttle and an exhausted plan window. An HTTP 429 is rewritten by the bundled client into `You
have hit your ChatGPT usage limit (<plan> plan). Try again in ~N min.`, while a limit hit mid-stream
arrives as an in-stream error event (`Codex error: The usage limit has been reached`, with the raw
`usage_limit_reached` code and an optional `resets_at` / `resets_in_seconds` in its payload). Ficus
lets the announced reset window decide for both: under 30 minutes is treated as a transient rate
limit with that reset, and a longer or absent window as a plan limit on its reset or the 30-minute
default.

Every account and provider summary reports `health`, `retryAt`, `healthReason` (the health record's
kind) and `healthMessage`, so the settings page can say WHY a provider is out and how long is left
rather than a bare "Exhausted". Reset it early with the **Reset** button on that exhausted row in AI
Providers settings, or from the CLI:

```bash
ficus provider-auth reset <provider>                     # provider + all of its accounts
ficus provider-auth reset <provider> --account <id>      # one account only
```

Records for an invalid or expired credential are never cleared: routing already treats those as
ready, so the record is the only thing telling you to re-authorize. The account endpoint answers
`409 credential_health` for them, the provider endpoint skips them and lists them in
`skippedCredentialHealth`, and the settings row shows re-authorize guidance instead of **Reset**.

Resetting asserts nothing about the upstream state — it only removes Ficus's record. If the provider
is in fact still exhausted, the very next request re-marks it with a fresh cooldown, so the worst
case is one wasted call.

### OAuth login intent (`POST /:provider/oauth/start`)

The optional body `{ "accountId": "acc_…" }` selects what the flow's completion writes:

- **omitted → ADD.** The completed credential is appended as a NEW account; existing accounts are
  never modified. If the credential carries an upstream identity (see below) matching an existing
  account, that account is refreshed instead of duplicated.
- **present → REAUTHORIZE.** Exactly that account's credential is refreshed in place. `/oauth/start`
  responds `404` if the account is unknown and `400` if it is not an OAuth account — but those are
  **start-time** checks only, and every one of them is re-validated at the write (see below), which is
  what actually prevents an api-key account being destroyed. If the login lands on a **different upstream account**
  than the one being re-authorized (both identities known and unequal), the completion is refused
  (`identity_mismatch`) and nothing is written — otherwise the target's credential would be destroyed
  _and_ two accounts would end up sharing one upstream identity, which breaks the dedupe invariant and
  the per-account failover/health accounting that assumes distinct upstream quotas. The error points
  the user at "Add account".

  A dedupe/reauthorize match **re-enables a disabled account**: re-authorizing is taken as intent to
  use it again, and it can be disabled again afterwards.

`pendingFlows` is **process-local**, so the supersede/retire guarantees below hold within a single API
process. A multi-instance deployment would not share them — OAuth already needs callback affinity for
the same reason. The under-lock re-validation above is the part that survives regardless, because it
runs against the shared, row-locked store.

Only one flow per provider is pending at a time. Starting a flow with a **different** intent (or
restarting one that has not yet surfaced a need) **retires** the pending flow and replaces it, so a
stale or abandoned flow can never be adopted by a later caller and write to the wrong account.
Re-starting with the same intent reuses the in-progress flow (`status: "already_started"`).

`cleanupStaleFlows()` runs only on `/oauth/start`, so the 10-minute age is **not** a bound: an
abandoned flow for a provider nobody starts again is never swept, and its login may still be running.
That is benign precisely because every precondition is re-checked at the write — such a flow can
occupy a slot, but it cannot write.

Retiring marks the flow `superseded`, aborts it via `AuthInteraction.signal`, and rejects its
manual-code promise. Only the **first** of those is a guarantee: aborting and rejecting merely stop a
cooperative login early, and a device-code login (xAI, Codex's headless option, Radius) sits in a
polling loop rather than awaiting the code promise, so it can still run to completion.

**Every start-time precondition is re-validated at the write.** `/oauth/start` gates a flow on three
things — the target account exists, it is an OAuth account, and no conflicting flow is pending — and
arbitrary time and arbitrary user actions pass before that flow completes. So `persistOAuthCredential`
re-checks all of them under the write lock and writes nothing unless they still hold:

| precondition                              | outcome if violated                                 |
| ----------------------------------------- | --------------------------------------------------- |
| target account still exists               | `account_not_found`                                 |
| target is still an OAuth account          | `wrong_type`                                        |
| target is still the same upstream account | `identity_mismatch`                                 |
| the flow was not cancelled                | `superseded` (checked by the caller, same callback) |

The type re-check is not theoretical. Account ids are **deterministic and recycled** —
`migrateLegacyAuthData`, `upsertProviderCredential`'s empty-provider branch, and
`salvageStrayCredentials` all mint the fixed ids `acc_migrated` / `acc_salvaged`. Re-authorizing a
legacy migrated OAuth account, deleting it, and then adding an API key for that provider recreates
`acc_migrated` as an **api_key** account; without the re-check the in-flight login would overwrite —
destroy — that key, and `identity_mismatch` cannot help because an api-key credential carries no
identity. Deleting an account also retires any flow aimed at it, but that is defence in depth: the
under-lock check is the guarantee, since a store can also change out of band (pi-ai's
`CredentialStore.delete` drops a provider entry without consulting `pendingFlows`).

**Where the flag is read is load-bearing.** `superseded` is re-read as the first statement inside the
`mutateAccountStore` callback — i.e. under the very lock that guards the write. Reading it any earlier
is worthless: that callback does not run inline, it queues on the store's serial queue and then
executes inside a transaction after a row-locked `SELECT … FOR UPDATE` that every `lastUsedAt` stamp
contends on, so a flow retired anywhere in that window would sail past an earlier check and still
write. The invariant is not "a retired flow has left `pendingFlows`" — that is only a proxy, and it
leaks — it is **a flow whose intent the user cancelled never writes**, which can only be enforced at
the write itself. A retired flow's callback responds `500` explaining nothing was saved.

**Removal and retirement are fused.** `retireAndRemove` is the only way a flow may leave
`pendingFlows`: it always marks the flow `superseded` (with a reason), aborts it, and then removes it
_by identity_, so a predecessor's late callback cannot evict the successor flow the user is currently
looking at. An ESLint rule (`no-restricted-syntax`, scoped to this file) rejects any other direct
`pendingFlows.delete(...)`; the single sanctioned call carries an `eslint-disable` with its rationale.

That rule is a **guard rail, not a proof**: it matches direct member calls only, so it cannot see an
aliased receiver (`const f = pendingFlows; f.delete(…)`) nor a flow displaced via `pendingFlows.set`.
The behavioural tests under "cancelled flows never write" are the genuine net, because they assert the
property that actually matters (no write) rather than a structural proxy for it.

The provider slot is claimed _before_ the runtime-building awaits in `/oauth/start`, and re-verified by
identity afterwards (a blind re-set would reinstate a superseded flow over the live one). The loser of
a concurrent start gets `409` rather than being silently orphaned.

Note: a superseded, timed-out, or mismatched flow has usually already **minted real tokens upstream**,
which ficus then discards. Those tokens are simply abandoned; the user must run the login again to
obtain a credential ficus will store.

Identity: OpenAI Codex OAuth credentials carry `credential.accountId` (the ChatGPT
`chatgpt_account_id` claim pi-ai decodes from the access-token JWT), which drives both the dedupe
step and the appended account's default label. Other providers return no identity claim, so dedupe is
skipped and the credential is simply appended.

## Implementation

| File                                           | Purpose                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/core/src/routes/provider-auth.ts`        | API routes — API key CRUD + OAuth flow management                               |
| `apps/core/src/services/agent/auth-backend.ts` | `SecretStoreAuthBackend` — bridges pi-coding-agent's AuthStorage to SecretStore |
