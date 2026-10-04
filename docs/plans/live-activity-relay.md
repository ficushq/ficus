# Live Activity relay transport

Status: contract and Core HTTP adapter prepared; registration storage, relay
endpoints and runtime fan-out wiring are not enabled. Tracked by Core #442.
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

## Remaining implementation and acceptance

1. Durable relay tables, signed registration/rotation endpoints, lifecycle
   admission and provider worker with fenced completion, retention and cleanup.
2. Native immutable lifecycle attribute/token registration and foreground
   recovery, preserving per-instance ownership across account/server switches.
3. Core capability storage and durable fan-out sequencing; choose relay only
   for relay registrations. Keep direct APNs registration and transport intact.
4. Wire the prepared provider payload builder to the fixed ActivityKit topic
   and registered environment; add receipt/result redaction and rate limits.
5. Real-device remote start/update/end and token rotation; app closed/offline;
   expiry/refund/opt-out; response loss; restarts; concurrent workers; 410; wrong
   instance/capability; privacy previews; stale update after end. Record the app
   and server versions. Ordinary alert delivery is not this acceptance test.

Do not enable commercial native gates or claim background relay support until
these pieces and device acceptance pass. Public self-hosted Core remains usable
without this optional relay.
