# Ficus App Deployments

## What Ficus supports

- Private authenticated sandbox local apps from squad workspaces.
- Skill-guided external provider deployments.
- Named provider accounts connected in Settings → Integrations and assigned per squad; CLIs authenticate through the PATH wrapper.

## What Ficus does not support in this scope

Ficus-managed Kubernetes is not a production app host. Do not create app Deployments, Services, Ingresses, image build/push pipelines, or Kubernetes rollback flows for user apps.

## Operator deployment topologies

Ficus itself supports three common serving topologies:

1. **Single-origin built-in:** build `apps/web/dist` and run Core with `FICUS_SERVE_WEB=1` so `/`, `/api/*`, `/ws`, and `/ws/terminal` share port `3000`. This is best for self-hosted VMs and simple Docker deployments.
2. **Split web/API:** serve the web UI separately (Vite, static files, or CDN) and route `/api/*`, `/ws`, and `/ws/*` to Core on `3000`.
3. **Kubernetes/CDN:** use the `ficus-api` and `ficus-worker` deployments with a separately hosted web build; leave `FICUS_SERVE_WEB` unset unless intentionally changing that topology.

In topologies 1–2 the worker's stream server (`WORKER_PORT`) binds `127.0.0.1`
by default — the API reaches it over loopback on the same host. Reaching it from
another host or container network requires `HOST` or `FICUS_WORKER_BIND` (see
[configuration](configuration.md)); Kubernetes is auto-detected and binds all
interfaces for pod-IP probes.

See [Single-origin and reverse proxy deployment](reverse-proxy.md) for copy-paste Caddy, nginx, and Traefik examples.

## Local app lifecycle

1. Agent identifies command and port.
2. Agent starts a managed local app with `ficus deploy local start` or attaches an existing port. When attaching, the agent can optionally register `--log-path`: a log file the app already writes (relative to the squad workspace, or absolute inside it) that the deployments panel then streams like a managed app's logs — rotation included. Without `--log-path`, the panel explains that no logs are captured for an attached app.
3. Ficus returns an authenticated local app URL.
4. Ficus supervises managed local apps and can restart them while their sandbox remains available. This is not an idle keepalive or durability guarantee for arbitrary detached work on VM boxes.
5. Human or agent stops local apps explicitly.

Registered log paths must stay inside the squad's workspace: relative paths resolve against the workspace root, traversal (`..`), absolute paths outside the workspace, and cross-squad paths are rejected with a 400, and symlink escapes are re-checked inside the sandbox on every read. A registered file that is missing or unreadable shows a one-line notice in the log viewer instead of an error.

### App aliases

On a hosted instance (`FICUS_APPS_DOMAIN` set) each app is served at `<tenant>--<first 12 hex of its id>.<apps domain>`. An app may also take an alias, so it is served at `<tenant>--<alias>.<apps domain>` instead, for example `noah--dashboard.ficus.garden`:

- Set it when creating the app (`--alias <name>` on `ficus deploy local start`/`attach`, or `alias` in the create body), or later with `ficus deploy local alias <id> <name>`, the alias editor in the web local apps panel, or `PATCH /api/local-deployments/<id>` with `{ "alias": "<name>" }`. Remove it with `ficus deploy local alias <id> --clear` or `{ "alias": null }`.
- Every app link Ficus shows, copies or opens (`urlPathOrHost` in the API, the CLI, the panel, agent tools) uses the alias host while there is one, and the id host otherwise.
- The id host keeps working. While the app has an alias, it redirects to the alias host (307, same path and query), and a token link lands signed in there. WebSockets are served on both hosts.
- An alias uses lowercase letters, digits and single hyphens. It cannot contain `--`, start or end with a hyphen, look like the 12-hex id form, or be a reserved name such as `api`, `www` or `status`, and `<tenant>--<alias>` must fit in 63 characters. Aliases are unique per instance. A removed, renamed or archived app's alias stays unavailable to other apps for 24 hours.
- Without `FICUS_APPS_DOMAIN`, an alias cannot be set; apps stay on `/api/app/<id>/`.

The routing contract, including the pending Platform bridge change that alias hosts need on Ficus Cloud, is in [integration contracts](integration-contracts.md#app-aliases-tenant--aliasapps-domain).

### Managed local app reconciliation

The worker reconciles live local apps immediately on Core startup and every **30 seconds** by default (`LOCAL_APP_HEALTH_POLL_INTERVAL_MS`). Health observation is read-only: it never ensures, recreates, starts or stops the app/box. A missing managed tmux session becomes `crashed`; a live session without a ready HTTP response becomes `unhealthy`. A tmux server Ficus cannot reach (see [Which tmux Ficus runs](#which-tmux-ficus-runs)) also becomes `unhealthy`: the session may still be alive, so it is never reported as `crashed` and never triggers automatic recovery. A TCP accept from an SSH tunnel is not proof that the app is listening. `running` requires both the deployment's own session and an HTTP response from `/` (200–499). Redirects are not followed, response bodies are not consumed, and each HTTP probe has a **2-second total deadline**. Attached web apps require the HTTP response but have no managed session identity check. This is readiness, not an application-specific health check or a cryptographic identity guarantee.

The **entire observation**, including executor attachment/session inspection/target resolution, has a **5-second deadline**. Expiry records `unhealthy` (health unverified), aborts only the read invocation, and prevents late results from writing `running`. Read/cancellation ownership is retained until cleanup settles, with at most two pending observations per Core process; ticks do not start duplicate reads while an earlier cancellation is pending. Evidence is shared only for the same lifecycle snapshot and target. A different snapshot remains unverified until the owned read/cleanup permits a fresh observation (a stale caller cannot cancel a newer read); old missing-session or healthy evidence cannot be applied to the new generation. Capacity exhaustion also reports unverified rather than falsely declaring a crash.

With responsive Core and database, N live apps take at most **5N seconds of observation time per tick**. Allowing for a loss just after an observation, completion of that tick, skipped overlapping timer ticks and the next scheduled tick gives a conservative status-correction bound of **30 + 10N seconds**, plus database query/write time (replace 30 with the configured poll interval). Sandbox transport hangs cannot enlarge this bound; an unavailable database or stalled Core cannot publish status updates. Restart startup schedules readiness observations every 500ms for a 10-second window; a final in-flight observation may use its additional 5-second budget. Shutdown cancels the owned startup timers and drains their observations. The app remains non-running until readiness succeeds.

The poller separately owns at most **two pending recovery jobs** per Core process. Mutating ensure/launch operations are **not** abandoned or raced against a health deadline; they retain single-flight ownership, and shutdown drains them and observation cleanup. A hung recovery does not block other health observations or future ticks. Each app has a 30-second restart cooldown (`LOCAL_APP_RESTART_COOLDOWN_MS`). After ensuring a box, automatic recovery re-observes the app: transport uncertainty does not authorize killing/relaunching a session, and a healthy session surviving a Core restart is left alone. Missing sessions or verified unready apps recover for managed `restartPolicy: always` apps. Recovery execution can take longer than status correction; its completion depends on the sandbox lifecycle operation settling.

Initial creation and recovery share the same in-process single-flight and cross-Core database launch lock. First launch still works for `restartPolicy: never`. Initial readiness has a finite 10-second grace tied to creation time (not extended by health writes): a booting app stays `starting`, never falsely `running`; after grace, missing sessions or unready listeners enter normal recovery. Automatic recovery rechecks readiness while holding the launch fence, so a creation in another Core cannot be immediately killed by a stale pre-launch decision. An incomplete initial row is not ignored forever after Core loss: reconciliation checks its stable session identity, so a surviving launch can be adopted and a missing managed-always session can recover. Stopped, archived, attached and never-restart apps are not automatically resurrected. An explicit restart may start a stopped managed app, but never an archived one. Stop/archive intent is persisted before process cleanup, and a late launch that loses to stop is reaped.

### Which tmux Ficus runs

Every Ficus tmux call on a box (managed app launch, stop and session checks, and agent monitors in squad and private agent boxes) runs one pinned tmux by absolute path. It is the first that exists of `/usr/bin/tmux`, `/usr/local/bin/tmux`, `/opt/homebrew/bin/tmux`, `/bin/tmux`, `~/.nix-profile/bin/tmux`, `/nix/var/nix/profiles/default/bin/tmux` and the devbox profile's tmux. `PATH` is used only when none of these exists. The user's `PATH` and devbox profile therefore cannot change which tmux Ficus runs. The app or monitor command itself still runs with the caller's `PATH` (see `apps/core/src/services/sandbox/launch-path.ts`).

tmux clients and servers of different versions cannot talk to each other. A 3.4 client talking to a 3.7 server prints `server exited unexpectedly`. Ficus therefore creates its sessions on its own socket (`tmux -L ficus`), and only the pinned binary ever starts that server. Sessions created before this change are on the default socket, so session checks and stops look at both sockets. A deploy neither orphans those apps nor reports them crashed; their next restart moves them onto the Ficus socket. A session check or stop never starts a server. If the pinned binary cannot talk to a server, Ficus retries with the other installed tmux binaries, in the same order, so a stale server started by another tmux (for example devbox's) is still found and stopped.

If no installed tmux can reach the server, the check reports it as unreachable (`tmux server on the box is unreachable (likely a tmux client/server version mismatch)…`, including tmux's own message). It never reports a missing session in that case. The app becomes `unhealthy` and is not restarted. A launch or stop that cannot reach the server fails with that same error rather than as a launch failure, and Ficus does not start a second copy of the app. To recover, stop the stale server with the tmux that started it (`<that tmux> kill-server`), then restart the affected apps. The implementation is in `apps/core/src/services/sandbox/tmux.ts`.

Only a confirmed terminal launch failure is reported as failed/crashed; transport loss or unknown launch outcome stays unverified/unhealthy until observation proves otherwise. Creation-route failure handling does not overwrite this classification or a newer stop/archive. Errors use fixed diagnostic reasons without raw commands or transport credentials. `restartCount` counts successful recovery launches, not initial launches or transport failures; a high count is a signal to investigate churn, not a reason to increase a limit. These changes require a Core API/worker update, not a database migration, app runtime change or new sandbox-server endpoint.

### Opening local previews with browser tools

Use `browser_open({ "localDeploymentId": "<full-deployment-uuid>" })` instead of copying the token-bearing URL into a tool argument. Ficus checks the calling agent's current `deployments:read` permission for the deployment's squad and rejects missing, archived, stopped, or expired deployments. The issued URL travels only through the internal browser transport; the tool does not echo it in its result or navigation errors. Existing preview token/cookie authentication and normal `browser_open({ "url": "https://example.com" })` support are unchanged.

Path-based apps require the operator's browser-reachable `APP_URL`; hosted app URLs retain their own origin. Inspect IDs/status without printing credentials using `ficus deploy local list <squad-id> --json | jq '.[] | {id, name, status, port}'`. Do not reconstruct redacted URLs or paste credentials into logs/messages. App screenshots and content still need review before sharing.

### Request headers the app never receives

The proxy removes `Authorization`, `X-Auth-Token` and `Cookie` from every request before it reaches the app, HTTP and WebSocket alike (`SENSITIVE_AUTH_HEADERS` and `stripUnsafeProxyHeaders` in `local-deployment-proxy.ts`). Ficus does not accept any of them as the app's credential: only the per-deployment token does. What is put back depends on the mount:

- **Per-app origin** (`<tenant>--<id>.<apps domain>`): the app owns its origin, so the browser attaches no Ficus credential to it. Once the request has passed the per-deployment token check, Core re-adds the app's own cookies (minus Ficus's, by exact name) and the browser's `Authorization` value, so an app that authenticates its own API with `Authorization: Bearer <app token>` receives it. A value that is or carries a Ficus credential is still dropped (`local-deployment-app-authorization.ts`): any Core token prefix (`ficus_sess_`, `ficus_agent_`, `ficus_dev_`, `ficus_sys_`, `ficus_wst_`, `ficus_wh_`) or schedule webhook token prefix (`whsec_`), the deployment token that authorized the request, any deployment's browser token, the bootstrap password, the sandbox callback secret or the demo reviewer secret, including inside a `Basic` value. `X-Auth-Token` is never forwarded.
- **Path mount** (`/api/app/<id>/` on the Ficus origin): shared with Ficus and every other app, so the app gets no `Authorization` and no cookies. Use the per-app origin, or a header of the app's own (for example `X-App-Auth`).

On the proxy route an `Authorization` header is not a Ficus bearer, so it does not exempt a request from, or subject it to, the bearer `Origin` check in `middleware/csrf.ts`. The value is never logged. Hop-by-hop headers, and any header the request's `Connection` names, are removed as well. On hosted instances the Platform bridge in front of Core still strips `Authorization` (a Platform change is pending), so until it passes the header through, hosted apps must use a header of their own such as `X-App-Auth` (see [integration contracts](integration-contracts.md#hosted-apps-the-host-selects-a-route-core-validates-access)).

### WebSockets through the local app proxy

The proxy relays WebSocket upgrades on both mounts: the hosted per-app origin and the `/api/app/<id>/` path (`apps/core/src/services/deploy/local-deployment-websocket.ts`, called from `local-deployment-proxy.ts`).

- **Authorization** is the HTTP rule: a valid per-deployment token, from `_ficus_token` or the path-scoped `ficus_app_<id>` cookie, is checked before the app is contacted. Cookie, `Authorization`, host and client-address headers follow the HTTP rules too. The path mount forwards no cookies and no `Authorization` to the app. The per-app origin forwards app cookies, minus Ficus's own, and the app's own `Authorization` unless it is a Ficus credential (browsers cannot set it on a WebSocket; other clients can).
- **Origin check:** a browser handshake must come from the app's own origin (`https://<app-host>`) on the per-app origin, or from an allowed Ficus web origin on the path mount. Anything else gets a marked `403`. A handshake without `Origin` is a non-browser client and needs only the token.
- **Path:** the socket must be opened under the app's mount. On the path mount that is `/api/app/<id>/…`. A bare `/ws` is Core's own event socket. Self-hosted reverse proxies must forward `Upgrade` for `/api/app/` as well as `/ws` (see [reverse proxy](reverse-proxy.md)).
- **Handshake:** Core opens the app's socket first, so a refusal or no answer within 15 s (`LOCAL_APP_WEBSOCKET_CONNECT_TIMEOUT_MS`) is a marked `502`, not an accepted socket that closes at once. The subprotocol the app chooses is passed to the browser. Frames, and code and reason on close, are relayed both ways. An abnormal close from the app (for example `1006`, no close frame) reaches the browser as `1011`.
- **Limits** are named constants in `local-deployment-websocket.ts`, passed explicitly to `Bun.serve` through `coreWebSocketHandler` (index.ts). Bun applies the server-wide ones to every Core socket; they equal Bun's defaults, so Core's own sockets are unchanged:
  - `LOCAL_APP_WEBSOCKET_IDLE_TIMEOUT_SECONDS` = 120 s idle timeout on the browser side, with Bun's automatic pings (`sendPings`), so an answering browser stays connected.
  - `LOCAL_APP_WEBSOCKET_MAX_PAYLOAD_BYTES` = 16 MiB per message, either direction; a larger one closes the socket with `1009`.
  - `LOCAL_APP_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES` = 16 MiB buffered per direction per socket (see backpressure below).
  - `LOCAL_APP_WEBSOCKET_PING_INTERVAL_MS` = 30 s between pings to the app (see heartbeat below).
  - `LOCAL_APP_WEBSOCKET_MAX_SOCKETS_PER_DEPLOYMENT` = 50 open sockets per deployment; one more is refused with a marked `429`.

  The `idleTimeout: 30` and `LOCAL_APP_PROXY_IDLE_TIMEOUT_SECONDS` values apply to HTTP requests, not open sockets. Limits of the hosted edge (the Platform bridge, Cloudflare) are outside this repository.

- **Access is re-checked while open.** Each relayed socket is registered under its deployment with the token that authorized it (`local-deployment-websocket-registry.ts`). On every `sandboxLocalDeployment.updated` event (emitted by every deployment write in `local-deployment-service.ts`, including `markLocalDeploymentsStoppedForSandbox`, and forwarded between Core's processes), and on a 60 s sweep (`LOCAL_APP_WEBSOCKET_REVALIDATE_INTERVAL_MS`) that catches changes no event announces (a squad deleted with its deployments, a direct database edit), Core re-applies the upgrade checks. A stopped, archived or deleted deployment closes its sockets with `1001`; a visibility change or a rotated or revoked token closes them with `1008`. A failed lookup keeps the sockets until the next check.
- **Backpressure:** no frame is dropped silently. Toward the browser, when Bun reports backpressure Core pauses reading from the app and resumes on drain; if Bun still refuses a frame, both sides close with `1013`. Toward the app, Bun's client socket cannot hold the browser back, so once more than the backpressure limit is queued for the app, both sides close with `1013` rather than buffering without bound.
- **Heartbeat:** Core pings the app's side of every socket each ping interval. A ping still unanswered at the next one (no pong and no frame) means a half-open app socket: Core drops it and closes the browser's side with `1011`. While reading is paused for a slow browser, no pong can be read, so the check waits.
- **Shutdown:** on `SIGTERM`/`SIGINT` Core refuses new upgrades (`503`), closes every relayed socket with `1012` (service restart) so browsers reconnect when it is back, then stops the server.
- **Logging:** debug-level lines for each open, refusal and close carry the deployment id, the status or close code, a fixed category (`unauthorized`, `at-capacity`, `token-revoked`, `app-heartbeat`, …) and the deployment's open-socket count. They never include the URL or query string, headers, cookies, the token, a close reason or a frame. Core has no metrics endpoint, so the count is logged rather than exported.
- **Lifetime:** sockets do not survive a Core restart, an app or box restart, or an edge reconnect, and nothing resumes them. Apps must reconnect. Some dev servers mishandle the old socket's late close after reconnecting (Next 16 dev HMR can hang on "Rendering"); a page reload recovers.

Direct loopback health probes do not verify proxy access. A provider-side `403` (such as Cloudflare error `1010` on unsigned requests) occurs before Ficus authentication and needs separate operator investigation, not weaker preview access controls.

## Security and cost guardrails

- Private local apps by default.
- Public exposure requires explicit human confirmation.
- Billing actions require explicit human confirmation.
- Integration credentials are available only to an authorized command through the assigned integration.
- Never read, print, log or persist integration tokens.

## Assigned deployment integrations

A person connects a named Cloudflare, DigitalOcean, Netlify, Railway, Supabase or Vercel account in **Settings → Integrations**, validates and enables it, then assigns it in the squad’s **Integrations** tab. Multiple accounts can be attached with a default, or selected explicitly for a command. GitHub Pages uses the assigned GitHub account. Imported deployment accounts are disabled and unassigned; exposure choices are not copied. See [upgrade actions](../upgrade/deploy-provider-connections.md).

An assigned, healthy account authenticates the provider CLI through its **PATH wrapper**. Credentials are resolved fresh for each command, never written into generated sandbox files or persistent environments. Revocation, disablement and unassignment deny new credential use immediately. Provider CLI installation and the matching deploy skill follow the normal integration projection; host runtimes require an operator-installed CLI.

Project-local CLIs and package-manager scripts may bypass global wrappers. Wrap the whole command:

```bash
ficus integration exec <provider> -- npm run deploy
ficus integration exec <provider> -- bun run deploy
ficus integration exec <provider> -- pnpm run deploy
ficus integration exec <provider> --connection <connection-id> -- <command>
```

Agent runtime context supplies the squad selector; otherwise provide `--squad <squad-id>` before `--`. Core still authorizes every invocation. Do not inspect or persist integration credentials. If a provider reports unauthenticated, ask a person to validate, enable or assign the account, rather than reading variables or restarting to reload a token. Human terminals remain token-free and may use the operator’s own CLI login. Custom app values can live in squad Environment Variables or human-directed workspace files; integration credentials must not be copied there.

## K8s local app smoke checklist

```bash
bun run k3d:setup
bun run reload:core
ficus deploy local start <squad-id> --name web --port 5173 --command 'bun --eval "Bun.serve({ hostname: \"0.0.0.0\", port: 5173, fetch() { return new Response(\"hello\") } })"'
```

Open the returned private local app URL and confirm it returns `hello`, then stop the local app:

```bash
ficus deploy local stop <local app-id>
```

For the underlying design, see App Deployment Support for Ficus Squads.

The compatibility `--env-secret-ref` option records legacy reference metadata
only; local apps do not resolve or inject those values. It is not a credential
delivery path. Use custom app env/files instead. Do not start persistent local
servers under integration exec: credentials belong only to a bounded command.
