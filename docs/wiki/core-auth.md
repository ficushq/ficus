# Core API Authentication

Ficus authenticates people with accounts and passkeys, browser sessions, and revocable device tokens. Route permissions govern access to resources. `FICUS_PASSWORD` remains a bootstrap/legacy credential while no administrator has a passkey; it is not the normal credential for an established instance.

## Security Model

User identities resolve permissions from role assignments, including squad-scoped access. Agents and scoped system API tokens have their own identities and authorization rules. Authentication establishes the caller; each protected route also checks authorization.

`FICUS_PASSWORD` is read through the [Secret Store](secret-store.md), including deployment configuration. Setup generates it to protect first-admin registration. When configured, the first-user registration flow requires a valid bootstrap-password identity. A bare installation without it permits first-user registration without that bootstrap gate, but protected API routes still require an identity. Removing `FICUS_PASSWORD` does not turn off account authentication or open all routes.

Password login and password bearer authentication stop working once an admin has a passkey. They remain available when admin records exist but no admin has a passkey, such as a restore that removed origin-bound credentials.

### Finishing first-admin setup

The bootstrap password resolves to a `legacy` identity. It passes administrator permission checks but belongs to no person. `GET /api/auth/validate` returns the caller's `identityType`. For the bootstrap identity it also returns `firstAdmin`: whether an admin record exists, and which enabled accounts without a passkey are waiting to become the first administrator with a passkey. When an admin record exists, only admins without a passkey are listed. Otherwise every account without a passkey is listed, including the account created by a first-admin registration whose passkey step failed.

While that list is not empty, the web app shows a finish-setup screen instead of the app. The screen creates a one-time registration link for the chosen account (`POST /api/users/:id/invite?delivery=link`). It then completes the normal link ceremony (`/api/auth/register/token/*`) in the same window. If no admin exists and the verify request carries the bootstrap identity, the account gets the admin role, as it would through `/api/auth/register/verify`. A link redeemed without the bootstrap identity grants no role. A failed passkey ceremony does not spend the link, so a retry can reuse it. After the passkey is registered, the browser holds a user session and the bootstrap password stops working.

Some routes act for one person, such as connecting accounts, subscriptions, session management, linked chat accounts and external export. They answer `403` with `code: first_admin_incomplete` for the bootstrap identity while no administrator has a passkey. Other identities that are not people get `code: user_session_required`.

## Identity Middleware

`apps/core/src/middleware/identity.ts` resolves credentials through `apps/core/src/services/auth/resolve-token.ts`. Credential extraction uses this order:

1. `Authorization: Bearer <token>`
2. `X-Auth-Token: <token>`
3. The browser's `ficus_session` HttpOnly cookie

The resolver recognizes unexpired user sessions, unrevoked agent tokens, scoped system tokens, paired-device tokens, and the bootstrap password when eligible. Each credential kind carries its own prefix (sessions `ficus_sess_`, agent tokens `ficus_agent_`, system tokens `ficus_sys_`, device tokens `ficus_dev_`), and the resolver looks a token up only in the table its prefix names: a value minted as another kind, or under an earlier product prefix, never authenticates as one of these. Missing or invalid credentials return `401`, apart from explicitly supported public or independently authenticated routes. Route permission checks can return `403` for authenticated callers without access.

## Login Flow

`apps/core/src/routes/auth.ts`

| Method | Endpoint                  | Description                                                                                        |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/auth/status`        | Login mode, admin/user presence, and whether self-registration is available                        |
| `POST` | `/api/auth/login`         | Validate the bootstrap/legacy password and set the session cookie while password login is eligible |
| `POST` | `/api/auth/login/options` | Begin a passkey authentication ceremony                                                            |
| `POST` | `/api/auth/login/verify`  | Verify the passkey response and create a user session                                              |
| `POST` | `/api/auth/logout`        | Revoke the matching browser session and clear its cookie                                           |

Passkey sessions store only the token hash in the database and expire after 30 days by default. The browser authenticates with an HttpOnly cookie rather than saving the password in JavaScript-readable storage. Cookie security attributes follow the deployment's origin and HTTPS configuration; CSRF middleware protects cookie-authenticated browser mutations. Explicit bearer clients remain supported.

**Settings → Account** manages profile information and passkeys. **Sessions** lists browser sessions for revocation, and **Paired Devices** manages mobile and CLI credentials. Registration after initial bootstrap follows the instance's invitation and allowed-domain policy.

## Device pairing & device tokens

The mobile app authenticates with a **per-device bearer token** (prefix `ficus_dev_`) rather than the shared password. Tokens are minted via a short-lived pairing handshake, stored hashed, resolve to the pairing user's identity, and are individually revocable — so losing a phone never means rotating the shared password.

| Method   | Endpoint                | Auth          | Purpose                                         |
| -------- | ----------------------- | ------------- | ----------------------------------------------- |
| `POST`   | `/api/auth/pair/start`  | authenticated | Mint a single-use, short-lived pairing code     |
| `POST`   | `/api/auth/pair/claim`  | public        | Claim a scanned/linked code → device token + id |
| `GET`    | `/api/auth/devices`     | authenticated | List my paired devices (self-service)           |
| `DELETE` | `/api/auth/devices/:id` | authenticated | Revoke one of my devices                        |

These live under `/api/auth` (mounted before the global auth middleware — see [Route Ordering](#route-ordering)); `pair/start` and the device routes do their own identity check, while `pair/claim` is intentionally public so an unpaired device can redeem a code. The claim is single-use (an atomic conditional update flips `claimedAt` from NULL, closing the concurrent-claim race). The issued token is then sent as a normal `Authorization: Bearer <token>` and accepted by the auth middleware like any other bearer credential.

The mobile-side UX — QR scan, the `tau://pair` deep link, web auto-detection, and sign-out revoke — is documented in [Mobile App → Pairing & authentication](mobile-app.md#pairing--authentication).

### CLI and Ficus Desktop browser authorization

`ficus auth login` and Ficus Desktop pairing both bootstrap a revocable device token without requiring an existing credential, using the same device-authorization flow. It creates two independent 256-bit capabilities: a verification secret carried only in the browser URL fragment and a polling secret sent only in JSON request bodies. Core stores only SHA-256 hashes. Grants expire after five minutes, enforce a durable five-second polling interval, and are consumed once.

| Method | Endpoint                   | Auth                      | Purpose                                              |
| ------ | -------------------------- | ------------------------- | ---------------------------------------------------- |
| `POST` | `/api/auth/device/start`   | public, rate limited      | Create a pending CLI or Ficus Desktop grant          |
| `POST` | `/api/auth/device/inspect` | authenticated user        | Preview the requesting CLI or Ficus Desktop instance |
| `POST` | `/api/auth/device/approve` | authenticated user + CSRF | Explicitly approve the request                       |
| `POST` | `/api/auth/device/token`   | polling capability        | Atomically mint and return one `ficus_dev_` token    |

`/device/start` accepts an optional `platform: 'cli' | 'desktop'` in its JSON body (default `cli`); any other value answers `400 invalid_platform`. The response echoes `platform` back, and it is a desktop-pairing support signal only when it comes back exactly `'desktop'` — an older server ignores `platform` in the request and always issues a CLI grant, so a caller must check the echoed value and discard the grant when it isn't `'desktop'` rather than treating its mere presence as support. A desktop-initiated grant defaults its device name to "Ficus Desktop" when the caller sends none, the same way a CLI grant defaults to "Ficus CLI".

The raw token is returned exactly once, stored in the CLI auth store with mode `0600`, and listed with mobile tokens under Paired Devices. Platforms are `ios`, `android`, `cli`, or `desktop`; unknown historical values render generically. Paired Devices labels a `desktop` token "Ficus Desktop", and the approval screen reads "Approve Ficus Desktop sign-in" for a desktop-originated request instead of the CLI wording. Web revocation and default CLI logout both revoke the token. Existing mobile QR payloads and `/pair/start` plus `/pair/claim` contracts are unchanged.

The verification URI a user is told to open is built from `FICUS_WEB_ORIGIN` (via `primaryWebOrigin()`), never from the request. Core never terminates TLS — every HTTPS deployment fronts it with caddy/nginx on plain `127.0.0.1` — so deriving the origin from the request would see `http:` and reject its own CLI; and a caller-supplied `Origin` must never be echoed into a URL a human is asked to trust. If `FICUS_WEB_ORIGIN` is missing or is not a secure origin, `/device/start` answers `400`.

Device-start rate limiting keys direct connections by Bun's socket peer address. A **loopback** peer is trusted as a proxy hop implicitly, because a same-host reverse proxy is the standard deployment and without it every caller on the instance shares one bucket. `FICUS_TRUSTED_PROXY_ADDRESSES` (comma-separated exact IPs) additionally trusts non-loopback proxies. `X-Forwarded-For` is honored **only** when the peer itself is trusted, so a remote caller cannot forge its way into the chain.

### Live-connection revocation

Authentication retains the paired-device row UUID beside the RBAC identity; raw device bearers and their hashes never enter connection registries or events. Device-derived single-use WebSocket tickets retain that UUID and fail consumption after the source device is revoked or its owner is disabled.

A committed device revoke closes matching local WebSockets immediately with code `4401` and the generic reason `Authentication revoked`; matching public SSE responses are aborted and closed. Reconnects authenticate normally and fail with the existing generic unauthorized response. Work already admitted before the revoke boundary may finish, but no later WebSocket message is delegated after the local registry marks the credential revoked.

Enforcement combines synchronous local dispatch, a best-effort authenticated `local-events` API↔worker fast path, and a one-second batched database recheck. `local-events` is point-to-point, not an API-replica broadcast; the authoritative database recheck bounds missed-event and horizontal-replica exposure and makes restarts fail closed. Present device tokens have no expiry column, so active checks cover revocation and disabled owners.

Immediate live socket termination is process-local; an already-open socket on another API replica is not immediately terminated today. The durable revoke remains authoritative and blocks every reconnect regardless of process. Multi-replica API deployment is not currently supported or planned, and broadcast/ack must not be implemented here. If multi-replica deployment becomes real, distributed revocation broadcast and acknowledgement is a prerequisite before claiming immediate replica-wide live-connection termination.

A device token still authenticates as its owning user and may approve a second, independently revocable device when that user has the required permission. Revoking one device does not revoke credentials it previously authorized; audit the Paired Devices list.

## WebSocket Authentication

Browser WebSockets use a short-lived, single-use `?ticket=` minted by `/api/auth/ws-ticket`; non-browser clients may use `?token=`. Ticket precedence, Origin checks, and RBAC permission checks are applied before upgrade. Device provenance is preserved through tickets so ticket minting cannot launder a device credential past later revocation.

## Route Ordering

`apps/core/src/index.ts`

CSRF protection is mounted for `/api/*` before the auth and webhook routers. Those routers precede the global identity middleware because login, registration, pairing claims, and provider webhook ingress need their own access rules. This does **not** make every `/api/auth` endpoint public: account, device, settings, and approval operations apply their own identity and permission checks.

Bearer/header-authenticated mutations skip the cookie-CSRF check only when they carry no `Origin` header at all (the normal CLI/agent shape); a bearer request that _does_ carry an `Origin` — including the opaque `Origin: null` a sandboxed iframe sends — must match the same web-origin allowlist CORS uses (`apps/core/src/services/auth/web-origins.ts`), or it's rejected with 403. This closes the gap where a native shell that injects a device bearer into its web view makes that bearer ambient to any cross-origin, no-preflight request a hostile page can fire from inside it.

The remaining API routers run through `identityMiddleware` and the `authzSentinel` authorization backstop. Protected endpoints require identity and route-specific permissions. Explicit exceptions, such as signed image URLs, deployed-app access links, and federation requests, use their documented public or signature-authenticated paths. Webhook ingress verifies provider signatures; webhook status/management routes require normal authorization.

## Secrets Access

`apps/core/src/routes/secrets.ts` and `apps/core/src/middleware/require-secret-permission.ts`

The secret list returns status metadata without values, filtered to the caller's read permissions. Reading a permitted individual key can return its decrypted value; writing and deleting require the corresponding secret-key/group permission. Authentication alone does not grant universal secret access.

Integration-owned credentials use their integration APIs and settings cards. Retired keys, including GitHub tokens and OpenAI API-service credentials, cannot be read or changed through the generic secret endpoints. Internal keys and platform-managed credentials have additional restrictions. Integration settings responses do not reveal saved secret values.

See [Secret Store](secret-store.md) for storage details and [Settings](settings-ui.md) for the owning configuration pages.

## Agent identities

Some API requests originate from agents rather than human users. Agent tokens (prefix `ficus_agent_`) resolve an agent identity. Squad-bound agents use their type role and squad scope. The personal User Assistant retains the internal type ID `system-manager`; its permissions resolve through its owning user. Do not assume every agent token is user-less.

**Role mapping** (in `apps/core/src/services/rbac/permissions.ts`):

| Agent type              | Resolved role                                                             |
| ----------------------- | ------------------------------------------------------------------------- |
| `manager`               | `default-manager`                                                         |
| `consultant`            | `default-manager` (full manager-equivalent permissions; no `ownerUserId`) |
| other squad-bound types | `default-worker`                                                          |

The Consultant is a squad-bound agent (`squadId` set, `ownerUserId` null) that is granted manager-level permissions through this mapping. See [Consultant](consultant.md) for the full design.

## Related Docs

- [Secret Store](secret-store.md) — How secrets are encrypted and stored
- [Mobile App](mobile-app.md) — Device pairing UX + per-device tokens
- [Provider Auth](provider-auth.md) — AI provider credential management
- [K8s Security](k8s/security.md) — Sandbox-to-Core auth, network isolation
- [Webhooks](webhooks.md) — Webhook signature verification (separate from user auth)
- [Consultant](consultant.md) — Per-squad human-facing agent; resolves to `default-manager` role

## Default access for self-registration

Sign-up settings can specify `defaultSignupRoleId` as a user-assignable role UUID or `null` for **No role**. The default is null. The selector appears for open sign-up and allowed-domain sign-up; invite-only accounts keep the roles selected in their invitations.

A new account created after email verification receives the configured role at **system (instance-wide) scope**, in the same transaction as user creation. Existing accounts, passkey recovery, and additional passkey registration do not receive new grants. Changing the default does not update existing users. Deleting the role resets the setting to null. First-administrator bootstrap remains separate.

Updating admission settings with a non-null role requires the settings editor to hold every permission granted by that role, as with manual user-role assignments. Agent-only roles are rejected. The selected default is not exposed in anonymous auth status; it is part of the protected auth settings resource.

For client feature discovery, see [server compatibility](server-compatibility.md).
