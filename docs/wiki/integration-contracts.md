# Integration contracts and compatibility boundaries

This page preserves cross-cutting implementation decisions from older integration
plans. It was checked against source on 2026-09-08; source inspection does not
establish a successful deployment or a current passing test run. Use
[AMTP](amtp.md), [GitHub connections](github-integrations.md),
[deployments](deployments.md), and the private
control-plane operations guide for setup.
Unresolved proposals and rollout evidence belong in
integration follow-ups.

## AMTP: protocol behavior belongs to the engine

Core consumes the external `amtp-engine` and `amtp-protocol` packages; its
conformance tests also use `amtp-node`. The Ficus adapters map instance identities,
peers, TOFU pins, replay records, outbox claims, attachments, handle lookup, and
receive policy onto Ficus storage. Delivery hooks translate accepted messages and
terminal failures into local inbox behavior. Protocol logic should remain in the
engine rather than being copied into these adapters. Handle registration and
mailbox reachability remain separate: a registered handle still needs an open
mailbox or an applicable allow rule.

The compatibility modules remain intentional interfaces:

- `outbox-delivery.ts` preserves `drainOutboxOnce` and creates an engine per call
  so injected resolver, signer, fetch, and batch-size dependencies retain their
  original behavior. A signer supplies signing material through `getSigning`;
  it is not required to provide a public identity record.
- `attachment-pull.ts` and `peer-key-fetch.ts` preserve callers and route-test
  reset seams. The route re-exports of `__setPullImpl` and `__setKeyFetchImpl`
  remain part of that compatibility arrangement. Attachment pulls read Ficus's
  size/storage caps per call, preserving the wrapper's original behavior rather
  than sharing the engine's per-receive snapshot.
- `send.ts` delegates enqueueing while preserving its original invalid-address
  error. Enqueue acceptance is not delivery confirmation; terminal failures
  produce a local bounce through the delivery hooks.

These are load-bearing compatibility boundaries, not dead-code candidates. Any
future dependency-injection cleanup must migrate the callers and tests together.
Key custody, identity-loss recovery, and TOFU rules remain governed by the AMTP
operator guide.

Implementation: [adapters](../../apps/core/src/services/amtp/adapters.ts),
[engine wiring](../../apps/core/src/services/amtp/engine.ts),
[delivery hooks](../../apps/core/src/services/amtp/hooks.ts),
[outbox wrapper](../../apps/core/src/services/amtp/outbox-delivery.ts),
[attachment wrapper](../../apps/core/src/services/amtp/attachment-pull.ts),
[key-fetch wrapper](../../apps/core/src/services/amtp/peer-key-fetch.ts), and
[routes](../../apps/core/src/routes/amtp.ts).
Historical rationale: engine extraction
and portable protocol.

## Hosted apps: the host selects a route, Core validates access

A configured app apex gives each deployment a browser origin of
`<tenant>--<deploy12>.<apps-domain>`. A separate registrable domain from Ficus's UI
provides cookie separation even if the UI later gains a domain-wide cookie;
serving the app at `/` also supports root-absolute asset URLs. This separation
depends on the operator's domain configuration. The encoded tenant and first
12 UUID hex characters avoid a second deployment registry on Platform; Core
still owns deployment lookup and rejects ambiguous prefixes.

Platform validates the host before routing: exactly one app label, a valid tenant
label of at most 49 characters, a lowercase 12-hex deployment suffix, and no port
or extra subdomain. The tenant registry must return an active tenant and a valid
server IP. Request-controlled destinations, forwarding hosts, schemes, and ports
do not determine the upstream. Platform dials that IP over HTTPS on port 443,
with the registry-derived tenant hostname for SNI and certificate verification
against the configured Origin CA root. There is no HTTP or TLS-verification
fallback.

The first tokenized request redirects to the validated HTTPS host, removes
`_tau_token` from the browser URL, and sets `__Host-tau_app` as a host-only,
Secure, HttpOnly, SameSite=Lax cookie. Platform forwards its credential to Core;
setting that cookie is not token validation. Core validates the deployment token
and deployment state. Platform removes unrelated cookies, authorization headers,
client-supplied `x-ficus-*` headers, and hop-by-hop headers before forwarding. Its
transport is HTTP streaming: `Upgrade` is stripped, so this route does not provide
WebSocket tunneling.

Resource bounds are 100 MiB in each direction, a 15-second connect timeout,
30-second idle timeout, and 64 concurrent requests per tenant per Platform
process, without a queue. A concurrency lease lasts through response-stream
completion or cancellation. Unknown and inactive tenants share the stopped-app
404 response. Core-marked proxy errors receive fixed messages; unmarked app-owned
responses retain their status. Logs use routing identifiers and failure causes,
not tokens or full request URLs.

Implementation: hostname parser,
tenant resolution,
router,
TLS configuration,
stream transport,
concurrency, and
[Core URL generation](../../apps/core/src/services/deploy/local-deployment-service.ts).
Historical rationale: app subdomain design.
The historical status and error-response checklist do not override current code.

## Hosted GitHub: subscription interest does not grant authority

Platform accepts the shared App's signed webhook and durably fans it out to
exact repository subscriptions. Instance authentication selects the tenant;
request bodies cannot select a different tenant or callback address. A
subscription proves current App/account identity and repository access. Before
releasing a queued payload, Platform checks the current token again, including
access to the specific event resource. It stores encrypted payloads and account
and repository identifiers, not the supplied access token.

Core discovers interests from work streams, flow subscriptions, and squad
triggers. It rechecks the connection's material revision, squad assignment, and
current interests before publication. Reconnecting changes delivery authority;
refreshing a token preserves its material revision. Neither a repository name nor
an installation ID grants a connection access. Relay events publish typed,
connection-and-squad-scoped integration outputs; they do not invoke instance-wide
legacy webhook shell rules. Direct tenant webhook delivery retains its separate
behavior.

Delivery leases and acknowledgment ownership support retry after a lost
acknowledgment. Fact keys deduplicate flow consumption. Subscriptions expire after
24 hours offline; payloads and receipts expire after 72 hours, with acknowledged
payloads cleared earlier. Provider polling remains the reconciliation fallback.
The managed consumer is gated on Platform management; self-hosted instances use
polling or their own signed ingress.

Implementation: relay routes,
provider checks,
durable store,
[Core runner](../../apps/core/src/services/integrations/relay/runner.ts), and
[publication boundary](../../apps/core/src/services/integrations/relay/runtime.ts).
Historical rationale: hosted delivery design.
