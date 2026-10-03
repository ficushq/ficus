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
`_ficus_token` from the browser URL, and sets `__Host-ficus_app` as a host-only,
Secure, HttpOnly, SameSite=Lax cookie. Platform forwards its credential to Core;
setting that cookie is not token validation. Core validates the deployment token
and deployment state. Platform removes authorization headers, client-supplied
`x-ficus-*` headers, and hop-by-hop headers before forwarding. Its HTTP
transport is streaming and strips `Upgrade`; WebSockets follow the separate
contract below.

### Cookies and host on the app origin

The app origin belongs to the app, so its cookies make the round trip and it
sees its own host. The apps domain is not a public suffix, so the browser
would let one app set a cookie with `Domain=<apps domain>` that every other
app, of every tenant, then receives. Both proxies therefore make app cookies
host-only. Ficus cookie names are:

- `ficus_session` and `tau_session`
- `ficus_app` and `ficus_app_<uuid>` (plus `tau_app_<uuid>`)
- `__Host-ficus_app` and `__Host-tau_app`

None of them exists legitimately on the apps domain. Each hop has a job:

- **Platform bridge**, request: forward the browser's `Cookie` header minus
  every Ficus cookie name, removed by exact name (the `_<uuid>` forms match a
  lowercase UUID exactly), never by a looser pattern. The credential goes to
  Core only as the `_ficus_token` (or legacy `_tau_token`) query parameter it
  already sets, never as a cookie. If no cookie is left, send no `Cookie`
  header. Set `X-Forwarded-Host` to the validated app host
  (`<tenant>--<deploy12>.<apps-domain>`, lowercase, no port), never a
  client-supplied value. Keep `Host` as the tenant hostname (the tenant Caddy
  routes on it) and `X-Forwarded-Proto: https`.
- **Platform bridge**, response: for every app `Set-Cookie`, drop it if its
  name is a Ficus cookie name. Otherwise remove every `Domain` attribute
  (case-insensitive name, any spacing) and pass the rest through unchanged.
  The bridge is the one chokepoint for every tenant, including tenants on an
  older Core, so it must do this itself.
- **Tenant Caddy** (`render_caddyfile` in `scripts/setup/lib.sh`): keeps an
  incoming `X-Forwarded-Host` only on `/api/app/*` and only when the
  immediate peer is one of the extra `ingress.trusted_proxies` (the bridge).
  Everywhere else, including traffic through Cloudflare, it is pinned to the
  tenant host.
- **Core** (`middleware/identity.ts`, `services/deploy/local-deployment-proxy.ts`):
  `/api/app/*` authenticates only by the deployment's browser credential. A
  Ficus session cookie or bearer token there is neither required nor
  consulted, so a stray `ficus_session` on the app origin cannot turn the app
  into a 401. A request counts as coming from the app origin only when the
  socket peer is a trusted proxy (loopback or `FICUS_TRUSTED_PROXY_ADDRESSES`,
  the chain used for `X-Forwarded-For`) and `X-Forwarded-Host` is exactly this
  deployment's app host. Core then forwards the cookies minus the Ficus names,
  sets `Host` and `X-Forwarded-Host` to the app host and `X-Forwarded-Proto`
  to `https`, and returns the app's `Set-Cookie` host-only (Ficus names
  dropped, `Domain` removed), the same as the bridge. Any other forwarded host
  is ignored.

The path mount (`<tenant host>/api/app/<id>/`) shares the Ficus origin with
Ficus and every other app. No cookie reaches the app there, because it would
carry the Ficus session and other apps' cookies. None of the app's
`Set-Cookie` reaches the browser either, because it could overwrite Ficus's or
another app's cookies. Core sets only its path-scoped `ficus_app_<id>` access
cookie. The app sees the Ficus host in `Host` and `X-Forwarded-Host`. Apps
that need sessions must use the app origin.

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

### WebSockets on either mount

A WebSocket handshake (a GET with `Upgrade: websocket` that `Connection`
names) to `/api/app/<id>/*` is an ordinary app request that becomes a socket.
Dev servers use it for hot reload (Next.js `/_next/webpack-hmr`, Vite).

- **Core** authorizes the handshake exactly like HTTP: the same credential,
  the same 404/401 before anything reaches the app, and the same cookie,
  host and client-address headers for each mount. It also checks the
  handshake's `Origin`, because a socket is not gated by CORS and the Lax
  credential cookie is sent from any same-site page (other apps and tenants
  share the site). On the per-app origin, `Origin` must be exactly
  `https://<app host>`. On the path mount, it must be a Ficus web origin. A
  missing `Origin` means a non-browser client, which is allowed. Anything
  else gets a marked 403. Core opens the app's socket first. If the app
  refuses or does not answer within 15 seconds, Core returns a marked 502 and
  no socket opens. The app's chosen subprotocol goes back in the 101. Frames
  are relayed unchanged in both directions, and so are close codes and
  reasons (a code that cannot be sent becomes 1000 toward the app and 1011
  toward the browser). Each hop negotiates its own extensions. A `Set-Cookie`
  on the app's 101 is not relayed, so set cookies on HTTP responses.
- **Tenant Caddy** needs no change: `reverse_proxy` passes upgrades, and the
  `@app_bridge` rule treats a handshake like any other `/api/app/*` request.
  A Caddy config reload closes open sockets, and HMR clients reconnect.
- **Platform Caddy**: on the apps-domain site, the `@app_socket`
  matcher (a `GET` whose `Upgrade` is `websocket` and whose `Connection`
  names `upgrade`) sends handshakes to the app socket listener. Everything
  else goes to the HTTP port as before. Both routes set the same
  `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`. Caddy only
  routes; the listener checks the handshake itself.
- **Platform bridge** (per-app origin): `Bun.serve` cannot hand over a raw
  socket, so handshakes have their own loopback `node:http` listener in the
  Platform process. It listens on
  `PLATFORM_APP_SOCKET_PORT` (default `4101`, from `platform.app_socket_port`,
  which must differ from `platform.port`) and starts only when the apps
  domain is configured. If it cannot bind, Platform logs the error and keeps
  serving HTTP. A request on this listener that is not a handshake gets a
  fixed 400.
  1. A handshake is authorized exactly like HTTP, by the same code: host,
     tenant and `__Host-ficus_app` credential checks, with the same fixed
     refusals before anything is dialed.
  2. The bridge dials the tenant exactly as for HTTP (registry IP, port 443,
     tenant SNI, Origin CA verification) and sends an HTTP/1.1 GET for the
     same rewritten target, `/api/app/<deploy12>/<path>` with the browser
     query plus `_ficus_token`. The HTTP request-header rules apply
     unchanged: `Cookie` minus Ficus names, `Host` set to the tenant host,
     `X-Forwarded-Host` set to the validated app host,
     `X-Forwarded-Proto: https`, the same single client address, and
     authorization and `x-ficus-*` stripped. `Upgrade: websocket`,
     `Connection: Upgrade` and the browser's `Sec-WebSocket-Key`,
     `Sec-WebSocket-Version`, `Sec-WebSocket-Protocol` and
     `Sec-WebSocket-Extensions` are added. `Origin` stays as the browser sent
     it, because Core checks it against the app host. If Core refuses the
     credential (its marked 401), the bridge retries once under the other
     credential name, as for a bodiless HTTP request.
  3. On `101`, the browser gets a 101 with only Core's `Upgrade`,
     `Connection`, `Sec-WebSocket-Accept`, `Sec-WebSocket-Protocol` and
     `Sec-WebSocket-Extensions`, plus any `Set-Cookie` under the response
     rule above. The two streams are then spliced byte for byte; frames are
     never parsed. When either side closes or errors, the other is closed.
     Any other status is an ordinary HTTP response (read whole, up to 1 MiB)
     and goes through the HTTP error normalization, so a marked
     401/403/404/502 gets its fixed message. A failed dial gets the generic 502.
  4. The handshake keeps the HTTP timeouts (15 seconds to connect, 30
     seconds for Core's answer). An open socket never holds one of the 64
     HTTP request leases, and the 100 MiB and 30-second HTTP bounds do not
     apply to it. Each tenant may have 64
     open sockets per Platform process; the next handshake gets the busy 503.
     A socket closes after 10 minutes without traffic in either direction,
     well above Core's 120-second ping timeout. Logs follow the HTTP rule: no
     tokens or full URLs.

  Rollout: the control plane must configure `PLATFORM_APP_SOCKET_PORT` and the
  `@app_socket` route on the apps-domain Caddy site. Until both are active,
  handshakes reach the HTTP port and are not upgraded. The tenant also needs a
  Core release with the matching WebSocket bridge support.

- **Cloudflare**: WebSockets must be enabled (the default) on both the Ficus
  zone and the apps-domain zone.

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
