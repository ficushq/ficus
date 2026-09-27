# Ficus App Deployments

## What Ficus supports

- Private authenticated sandbox local apps from squad workspaces.
- Skill-guided external provider deployments.
- Provider tokens stored in Secret Store and explicitly exposed per squad when a sandbox needs them.

## What Ficus does not support in this scope

Ficus-managed Kubernetes is not a production app host. Do not create app Deployments, Services, Ingresses, image build/push pipelines, or Kubernetes rollback flows for user apps.

## Operator deployment topologies

Ficus itself supports three common serving topologies:

1. **Single-origin built-in:** build `apps/web/dist` and run Core with `FICUS_SERVE_WEB=1` so `/`, `/api/*`, `/ws`, and `/ws/terminal` share port `3000`. This is best for self-hosted VMs and simple Docker deployments.
2. **Split web/API:** serve the web UI separately (Vite, static files, or CDN) and route `/api/*`, `/ws`, and `/ws/*` to Core on `3000`.
3. **Kubernetes/CDN:** use the dedicated `tau-api`, `tau-worker`, and `tau-web` deployments; leave `FICUS_SERVE_WEB` unset unless intentionally changing that topology.

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

### Opening local previews with browser tools

Use `browser_open({ "localDeploymentId": "<full-deployment-uuid>" })` instead of copying the token-bearing URL into a tool argument. Ficus checks the calling agent's current `deployments:read` permission for the deployment's squad and rejects missing, archived, stopped, or expired deployments. The issued URL travels only through the internal browser transport; the tool does not echo it in its result or navigation errors. Existing preview token/cookie authentication and normal `browser_open({ "url": "https://example.com" })` support are unchanged.

Path-based apps require the operator's browser-reachable `APP_URL`; hosted app URLs retain their own origin. Inspect IDs/status without printing credentials using `ficus deploy local list <squad-id> --json | jq '.[] | {id, name, status, port}'`. Do not reconstruct redacted URLs or paste credentials into logs/messages. App screenshots and content still need review before sharing.

Direct loopback health probes do not verify proxy access. A provider-side `403` (such as Cloudflare error `1010` on unsigned requests) occurs before Ficus authentication and needs separate operator investigation, not weaker preview access controls.

## Security and cost guardrails

- Private local apps by default.
- Public exposure requires explicit human confirmation.
- Billing actions require explicit human confirmation.
- Secrets stay in Secret Store until a human explicitly allowlists selected keys for a squad sandbox.
- Never expose all Secret Store keys to a squad automatically.

## Provider deployment secret exposure

Save deployment credentials in **Settings → Integrations**. Cloudflare, DigitalOcean, Netlify, Railway, Supabase, and Vercel each have a card with a global enable switch and protected token field. GitHub Pages uses the GitHub integration’s account. Existing tokens and exposure choices are preserved on upgrade; fresh integrations start disabled. Secrets & Keys and `ficus secret set` no longer edit these provider tokens.

Disabling a provider retains its saved token and allowlists, but removes that token from generated squad environments. Re-enabling restores it to the same squads. Rotating a token updates both squad-specific and global exposures. A credential already copied into a running process remains subject to the provider’s own token revocation.

Provider skills use Ficus Secret Store names such as `DEPLOY_VERCEL_TOKEN` and `DEPLOY_CLOUDFLARE_TOKEN`. These values are not automatically available in squad sandboxes. Before running provider CLI commands, a human admin/operator must explicitly expose only the required secret keys to the squad through the squad **Environment** settings UI or the admin/operator CLI:

```bash
# Lists names/status only; does not print secret values.
ficus squad-env secrets <squad-id>

# Allowlist only the provider token needed by this squad.
ficus squad-env expose-secrets <squad-id> DEPLOY_VERCEL_TOKEN

# Or expose common deployment tokens to every existing and future squad.
ficus squad-env expose-global DEPLOY_VERCEL_TOKEN
```

You can also configure this in the squad **Environment** settings UI. The UI lists Secret Store key names, set status, and exposure status only; it never displays secret values.

Secret exposure storage model:

- Selected key names are stored in Core's server-controlled database tables, not in the workspace.
- Globally exposed keys are rendered into every existing squad env file immediately and into future squad env files when generated.
- User-authored environment content is stored in `.tau/env.user`.
- Reserved keys: squad env content may not assign `FICUS_TOKEN`, `FICUS_API_URL`, `FICUS_PASSWORD`, `FICUS_AUTH_STORE`, `FICUS_AGENT_CONTEXT`, `FICUS_AGENT_ID` or the `FICUS_IDENTITY_*` aliases. The agent's identity is injected by ficus; setting one in a squad env would make every agent in the squad act as a different identity, against a possibly different instance. Such a write is rejected with a 400 naming the key, and the same names are filtered out of Secret Store exposure rendering. `PATH` is not reserved — on the host runtime ficus re-prepends its `ficus` shim directory after the squad env is sourced, so PATH additions apply but cannot displace `ficus`.
- The generated sandbox env file `.tau/.env` contains `.tau/env.user` content plus selected Secret Store values so shells, local app commands, and deployment CLIs can source them.
- Normal APIs and UI responses return user-authored env content and key names/status only; they do not return generated plaintext Secret Store values.
- Secret Store rotation/deletion regenerates affected squad `.tau/.env` files so stale selected or globally exposed values are updated or removed.

Treat selected exposure as explicit access to that squad; do not use it for unrelated secrets.

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
