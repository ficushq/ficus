# Live Activity relay transport

Status: the contract, signed registration, durable delivery, bounded cleanup and
device recovery are implemented in staged changes, with delivery default off.
Tracked by Core #442; real APNs/device acceptance is still required.
Ordinary APNs alerts, direct APNs Live Activities and PWA Web Push are unchanged.

## Trust and ownership

ActivityKit uses distinct push-to-start and per-activity update tokens. An alert
relay capability must never authorize either. The shared contract lives at
`@ficus/shared/live-activity-relay`; activity capabilities use `ficus_pla_`.

The app registers its native token directly with the relay using the existing
installation key and short-lived signed challenge mechanism. The canonical
registration digest includes activation, capability, APNs token, environment,
kind, lifecycle UUID and native ActivityKit ID. Core enrollment can approve the
installation, but Core's runtime credential alone cannot register a destination.
The relay must fence stale challenge completions and token rotations with a
binding generation, retaining ended lifecycle tombstones.

The relay stores encrypted APNs tokens and hashes capabilities. The device sends
Core only the opaque capability and the routing/lifecycle identity it needs.
Production/sandbox, APNs topic, native attributes type and canonical server origin
come from the registered destination and relay configuration, never a send body.
An instance credential plus a destination capability must resolve to the same
installation/instance. No account-level browser credential is sent to Core.

## Lifecycle and ordering

- A start capability belongs to an installation and originating instance. Each
  start creates a fresh `activityKey` UUID, embedded in immutable native
  attributes alongside the relay-owned origin.
- The app reads that key when ActivityKit returns the update token and signs an
  update registration for the same installation/instance/lifecycle. A locally
  started activity generates the key before starting and uses the same proof
  flow. Native ActivityKit IDs are opaque; they are not lifecycle UUIDs.
- Admit at most one open aggregate lifecycle per installation and instance.
  Remote-start retry and app-local start must reconcile against that record.
  Rotation replaces a destination under the same lifecycle; it cannot resurrect
  an ended key. A replacement activity requires a new key.
- Core persists a strictly increasing sequence, event UUID and validated payload
  **before** network I/O. The same event is used on every retry and after restart.
  In-memory timestamps/counters are insufficient. End has no caller-supplied
  content; the relay constructs the empty state and immediate dismissal.
- The relay locks the owning installation/lifecycle, checks current coverage,
  capability generation and token kind, and records admission atomically. Start
  requires a start capability; update/end require that lifecycle's update
  capability. Ended keys remain terminal. The shared ordering helper assumes
  these authorization checks; it is not an authorization mechanism.
- Provider I/O runs outside the DB transaction under a bounded lease. A later
  send cannot overlap an in-flight send for the same lifecycle. Completion uses
  a lease compare-and-swap. A crash or timeout is **unknown**, never a successful
  duplicate. Exact retries are safe only after a definite failure; a duplicate
  success requires recorded provider acceptance.
- An ambiguous lifecycle is parked for reconciliation, not automatically sent
  again. A signed update registration can prove an ambiguous remote start
  reached the device; absent evidence it must expire without replaying start.
  Provider recovery/end policy must preserve strictly newer APNs timestamps and
  must not release a sending lease while an old provider call can still run.
- A new event can supersede a definitely finished/failed older event. Old
  sequences cannot overwrite it. APNs timestamps are relay-owned and monotonic
  per lifecycle; respect Apple's seconds resolution when coalescing events.

[Apple's ActivityKit delivery documentation](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)
describes the separate tokens, headers and timestamp ordering. The prepared relay payload builder supplies a fixed generic alert for remote
starts, as Apple requires, and fixes attributes, stale dates and empty end
content. The existing direct APNs builder omits that start alert; review that
separately before relying on direct remote-start delivery. Neither builder is
proof of real-device relay acceptance.

## Coverage, privacy and failure handling

Every start/update checks current Personal Pro **or** coverage from the
originating instance. Another instance's sponsorship is not portable. Relay
admission must not implicitly re-admit a previously personal-funded installation
against an instance's allowance. The app's cached offline grant is not sufficient
for Cloud delivery authorization.

Revocation/expiry must disable start and update admission immediately, schedule
best-effort content-free end for owned active destinations, and clear device
snapshots/activities on foreground. Cleanup authorization is limited to ending
that already-owned lifecycle; it must not mint a new lease, expose old content or
permit new starts. Instance/token revocation and account deletion need this same
cleanup path. Coverage stale dates alone do not end an activity.

Payloads use the existing counts/buckets/three-row projection. Titles are omitted
in favor of generic work references unless previews are enabled. The relay must
also enforce the installation's approved preview preference; Core cannot expand
it through a request. Validate the final UTF-8 APNs envelope size before provider
I/O, as distinct from the bounded relay HTTP request.

`sendRelayLiveActivity` posts only to the configured relay with the runtime-only
push credential. It bounds/validates responses and returns explicit delivery
outcomes. It does not retry internally, generate new identities, log provider
errors or fall back to direct APNs after a denial. The eventual caller must retry
only the persisted event, with bounded backoff, and stop on terminal denial,
revocation, conflict or unknown delivery. A 410 revokes only the affected activity
destination, not the device's ordinary alert subscription.

## Implementation and release acceptance

The staged runtime now persists Core capabilities and exact delivery identities,
uses device-signed registration and revocation, enforces originating-instance
coverage and preview privacy, and fences concurrent provider sends. Native
recovery replaces an uncertain update lifecycle rather than replaying it. A
start rejected because an old lifecycle is still closing retries the same event
with bounded backoff. `resetRequired` asks the client to replace an ambiguous
update lifecycle; rotating its token cannot establish delivery proof.

Before enabling delivery, validate real-device remote start/update/end and token
rotation; app closed/offline; expiry/refund/opt-out; response loss; restarts;
concurrent workers; 410; wrong instance/capability; privacy previews; and stale
updates after end. Record app and server versions. Ordinary alert delivery is
not this acceptance test. Public self-hosted Core remains usable without this
optional relay.

### Signed registration wire contract

Registration uses `liveActivityRegistrationChallengeSchema` and
`liveActivityRegistrationProofMessage`, a separate `ficus-live-activity-proof-v1`
domain. Before signing, the app verifies the returned activation/instance/origin
against its selected server and compares `operationDigest` with the SHA-256 of
its own `liveActivityRegistrationPayload`. The signature includes the digest,
nonce, expiry and registration generation. Preview consent is included in the
canonical operation and defaults off.

`POST /api/push-relay/live-activities/registration-challenges` accepts the strict
registration schema; `registration-proofs` accepts `{challengeId, signature}`
(the Ed25519 signature is 128 lowercase hex characters) and returns the strict
registration receipt. A stale pending generation fails; replaying a completed
proof can return its existing receipt but cannot overwrite a newer destination.
The app retries a rotation with a fresh challenge after a generation conflict.

Send protocol outcomes, including `in_flight` and `delivery_unknown`, use the
versioned JSON response envelope with HTTP 200. HTTP failures are ingress or
transport errors. This preserves the transport's distinction between an exact
retryable event and a provider outcome that must not be replayed.

## Durable Core runtime

`FICUS_LIVE_ACTIVITY_RELAY_ENABLED=true` explicitly enables the prepared relay
registration endpoint and bounded delivery runner. It remains off by default.
Human users submit strict capability receipts to `/api/push/live-activity/relay`;
raw APNs tokens remain on the independent direct endpoint. Cleanup is allowed
with delivery disabled. The client library exposes both modes separately.

Encrypted installation state contains destination capabilities, lifecycle key,
sequence, exact pending payload and retry state. Database leases serialize API
processes, recover abandoned sends and fence completions after registration or
removal. Core polls authoritative privacy-scoped work snapshots; changed content
never causes the old payload to be replayed. Native proof of a matching started
activity advances a pending start without pretending later updates were delivered.
Unknown delivery and protocol denials wait for device reconciliation. There is no
fallback to direct APNs. Device-signed Cloud revocation is required in addition to
Core removal, including when a removed account's Core credentials no longer work.


## User deletion cleanup

User deletion transactionally removes cached activity content and start authority,
invalidates any worker lease, and retains only an encrypted, content-free end
request without a user identity. The cleanup runner works even with new relay
admission disabled. Retries preserve the exact end identity; definite completion,
terminal denial, or the original 24-hour deadline removes the tombstone. A new
user cannot adopt an orphaned installation. Unreadable capability state is erased
rather than blocking user deletion; relay-side expiry remains the fallback.

A provider request already in flight cannot be recalled. Relay ordering prevents
it from overwriting an accepted newer end; uncertain delivery remains subject to
relay cleanup and device reconciliation. Device-signed Cloud revocation remains
necessary for client opt-out/removal, including when Core credentials have expired.
