---
name: deploy-app
description: Local app or deploy a user application from a Ficus squad workspace using Ficus sandbox local apps first, then external providers with explicit human consent.
---

# Deploying Apps from Ficus

## Command runtime

Run every repository, server, Docker, provider CLI, Devbox, `ficus deploy local`, and localhost probe command in this skill with `squad_bash` from the app project directory. The local deployment proxy reaches the shared warm runtime, not a private `bash` process. Use private `bash` only for the narrowly scoped private/sensitive exception described in your system prompt. If `squad_bash` is unavailable, do not start or attach a private local server as a squad app; delegate shared-runtime deployment work to an agent with that capability. Use another shell only for operations its Workspace & Sandbox prompt says can reach the required project/runtime. Server start, localhost probes, `ficus deploy local start`/`attach`/logs, diagnostics, and cleanup must all use that same shared runtime.

## Default rule

Prefer a private Ficus sandbox local app before any external production deployment.

Use external cloud providers only after:

1. You have identified the app type and deployment target.
2. Tests/build pass locally in the app project directory in your shared workspace.
3. The human has approved public exposure, billing, domains, databases, or always-on services.
4. Required provider tokens are stored in Ficus Secrets, not pasted into chat.

## First checks

```bash
pwd
find . -maxdepth 2 -name package.json -o -name Dockerfile -o -name vite.config.* -o -name next.config.*
ficus deploy local list <squad-id>
ficus secret list
```

## App type guidance

| App type                  | Default target                            | Notes                                           |
| ------------------------- | ----------------------------------------- | ----------------------------------------------- |
| Static HTML/CSS/JS        | GitHub Pages first                        | Easiest static default; no server runtime.      |
| Vite/React SPA            | GitHub Pages first if static export works | Use Vercel/Netlify if SSR/functions are needed. |
| Next.js                   | Vercel                                    | Verify DB/server-action needs.                  |
| Backend/API               | Railway                                   | Ask before always-on services.                  |
| Postgres/auth/storage     | Supabase companion service                | Ask before project creation/migrations.         |
| Dockerfile/custom runtime | Railway or DigitalOcean App Platform      | Billing guardrail required.                     |
| Edge worker               | Cloudflare Workers                        | Check runtime compatibility.                    |

## Project directory hygiene

Deploy from the app project's own directory, not the shared workspace root. Keep user/project code in a dedicated folder such as `<workspace-root>/<app-name>` (your workspace root is the shared workspace path named in your system prompt) or in the actual repository root for that app. If an app prototype was created directly in the workspace root, ask before moving it into its own subdirectory and run build/deploy commands from there.

Use provider ignore files only as a fallback; they do not replace deploying from the correct app directory. Examples: `.railwayignore`, `.vercelignore`, `.netlifyignore`, `.dockerignore`.

## Private Ficus local app

1. Build/test first.
2. Run dev servers on `0.0.0.0`.
3. Prefer managed local apps so Ficus can restart and stop them. This supervision is a convenience for apps, not a durability boundary for one-shot builds, migrations, tests, or generation jobs; keep those in one foreground Bash invocation.
4. **Do not pass `--port`.** Ficus assigns a free port and exports it as `$PORT`.
5. **Always honor `$FICUS_APP_BASE_PATH`**. Ficus supplies the correct root or path prefix for the instance.

```bash
# Managed local app: Ficus owns the tmux process, assigns the port, and exposes it.
ficus deploy local start <squad-id> \
  --name web \
  --cwd <workspace-root>/my-app \
  --command "bun run dev -- --host 0.0.0.0 --port \$PORT --base \$FICUS_APP_BASE_PATH"

# Attached local app: the server is ALREADY listening, so Ficus cannot choose —
# pass the port it is on. Rejected if another live app already holds it.
#
# To have Ficus capture the attached app's output, run it with its stdout/stderr
# redirected to a log file and register that file with --log-path. The path
# must stay inside the squad workspace (relative paths resolve against its
# root); the panel then streams the file live, rotation included. Without
# --log-path the panel explains that no logs are captured for the app.
nohup bun run dev -- --host 0.0.0.0 --port 5173 > my-app/dev.log 2>&1 &
ficus deploy local attach <squad-id> --name web --port 5173 --log-path my-app/dev.log

# List existing local apps.
ficus deploy local list <squad-id>
ficus deploy local list <squad-id> --include-archived # include archived local apps

# Inspect and clean up.
ficus deploy local logs <local app-id> --tail 100
ficus deploy local stop <local app-id>
ficus deploy local archive <local app-id>
```

Archive old or superseded local apps once they are no longer useful. Archiving stops/cleans up the running local app and moves it out of the active Apps tab list while preserving history in Ficus.

### The two environment variables Ficus injects

**`$PORT` — let Ficus pick.** A hard-coded port is a claim on a machine-wide
resource: on the VM runtime every squad's box runs as a user on ONE host sharing
one loopback, so two squads asking for 5173 collide. Ficus assigns a free port and
rejects an explicit one that another live app already holds. Read `$PORT`;
`$FICUS_LOCAL_DEPLOYMENT_PORT` is the same value under Ficus's own name.

**`$FICUS_APP_BASE_PATH` — always honor the value Ficus supplies.** On hosted
instances it is `/`: each app is served at its own origin root, so default
root-absolute asset URLs work by default. On a self-hosted instance or the path
fallback it is `/api/app/<id>/`; without that prefix, root-absolute assets such
as `/assets/index-*.js` miss the app. Use the same environment variable in both
modes so the project remains portable. Tell the framework:

| Framework           | Setting                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Vite                | `base` — flag `--base $FICUS_APP_BASE_PATH`, or `base: process.env.FICUS_APP_BASE_PATH` in `vite.config` |
| Next.js             | `basePath: process.env.FICUS_APP_BASE_PATH?.replace(/\/$/, '')`                                          |
| Create React App    | `PUBLIC_URL=$FICUS_APP_BASE_PATH`                                                                        |
| Plain static/server | emit RELATIVE asset URLs (`./assets/…`), or prefix them with the base path                               |

Symptom when this is wrong: the app's root URL returns 200 and renders a blank
page, and the browser console shows 404s (or Ficus's own HTML) for every
`/assets/*` request.

### Access is token-gated; you do not manage it

For browser tools, prefer `browser_open({ "localDeploymentId": "<full-deployment-uuid>" })`. Ficus checks the calling agent's current deployment-read permission and deployment state, then passes the issued URL directly to the browser backend. You do not need to print or copy a capability through tool output. To inspect a run without its credential URL, use `ficus deploy local get <id> --json | jq '{id, name, status, port}'`. See `frontend-visual-review` for the full loop.

The URL Ficus gives you carries `?_ficus_token=…`. That token authenticates the
first request and Ficus then sets a cookie scoped to that one app, so the app's
own scripts, styles and fetches authenticate automatically — nothing to
configure. Hosted `.app` URLs always use HTTPS.

WebSocket upgrades are not supported by the local or hosted app proxy. Use
ordinary HTTP, SSE, or polling, or choose an external deployment when the app
requires WebSockets.

Two consequences worth knowing:

- **The URL is the credential.** Anyone you send it to can open the app. Treat it
  like a password: do not echo it, paste it into browser-tool arguments, or post
  it in messages/logs. Use the deployment-ID handoff for agents and the Apps UI
  for humans; do not try to reconstruct a redacted token.
- **`curl` without the token returns 401**, not a connection error. When probing
  from a shell, hit the app directly on `127.0.0.1:$PORT` inside the sandbox
  instead of going through the proxy URL — a 401 there means your credential is
  missing, not that the app is down.

A proxy failure and an edge-provider rejection are different layers. For example,
Cloudflare `403`/error `1010` on unsigned requests occurs before Ficus's launch
validation. Report that environment restriction to the operator; neither copying
credentials nor weakening preview authentication fixes it.

## Consent gates

Ask the human before:

- Creating public unauthenticated local apps.
- Creating provider projects, sites, services, databases, domains, or paid resources.
- Deploying to production.
- Running database migrations against non-local databases.
- Storing new provider tokens.

## Provider runtime compatibility

For server/API/container apps, make sure the app listens on the provider-injected `PORT` instead of a hard-coded port. Static sites do not need this, but Node/Bun/HTTP servers usually do.

Example:

```ts
const port = Number(process.env.PORT ?? 3000)
```

Test with a non-default port before external deployment:

```bash
PORT=4173 timeout 5s bash -c 'bun run start >/tmp/app-port.log 2>&1 & pid=$!; sleep 1; curl -sS http://127.0.0.1:4173/; kill $pid; wait $pid || true'
```

## Secret handling and missing provider tokens

Do not ask users to paste secrets in chat. If a required deployment token is missing, read the matching provider skill and help the human create a token with suitable scope. Have them save it in **Settings → Integrations → the provider’s card** and enable the integration. Deployment tokens are no longer edited through Secrets & Keys or `ficus secret set`. GitHub Pages uses the GitHub integration’s connected account.

Existing tokens and squad exposure choices are preserved on upgrade. Global disable withholds the deployment token from generated squad environments; re-enable restores the previous exposure choices. Then have an admin/operator expose only the required provider token in the squad’s **Environment** settings.

Provider CLI commands in squad sandboxes can only read Secret Store values after a human admin/operator explicitly exposes selected secret keys to that squad in Environment settings or via the admin/operator CLI. Never expose all secrets automatically.

Use the provider's expected environment variable name while mapping from the Ficus secret:

| Provider     | Ficus secret key              | CLI environment variable                        |
| ------------ | ----------------------------- | ----------------------------------------------- |
| Vercel       | `DEPLOY_VERCEL_TOKEN`         | `VERCEL_TOKEN`                                  |
| Netlify      | `DEPLOY_NETLIFY_TOKEN`        | `NETLIFY_AUTH_TOKEN`                            |
| Cloudflare   | `DEPLOY_CLOUDFLARE_TOKEN`     | `CLOUDFLARE_API_TOKEN`                          |
| GitHub Pages | GitHub integration connection | Ficus resolves the assigned account per command |
| Railway      | `DEPLOY_RAILWAY_TOKEN`        | `RAILWAY_API_TOKEN` for account/project flows   |
| DigitalOcean | `DEPLOY_DIGITALOCEAN_TOKEN`   | `DIGITALOCEAN_ACCESS_TOKEN`                     |
| Supabase     | `DEPLOY_SUPABASE_TOKEN`       | `SUPABASE_ACCESS_TOKEN`                         |

Token troubleshooting:

- `ficus squad-env secrets <squad-id>` showing `isSet=true exposed=true` only proves Ficus has and exposes the secret. It does not prove the current process has the latest value or that the provider accepts the token.
- If a provider returns Unauthorized after a token was recently added/replaced, ask the human/admin to refresh/restart the agent/sandbox process and verify token type/scope.
- Do not put command strings containing `$DEPLOY_*_TOKEN` inside double-quoted `ficus inbox` or `ficus workstream request-input` messages; Bash can expand and leak secrets. Use single quotes or heredocs when mentioning env-var syntax literally.

```bash
# Bad: may expand the secret before sending the message.
ficus workstream request-input <id> -m "Run VERCEL_TOKEN=$DEPLOY_VERCEL_TOKEN vercel whoami"

# Good: keeps the env-var syntax literal.
ficus workstream request-input <id> -m 'Run VERCEL_TOKEN=$DEPLOY_VERCEL_TOKEN vercel whoami'
```

Provider CLI commands in squad sandboxes can only read exposed secrets:

```bash
# Shows names/status only; never prints secret values.
ficus squad-env secrets <squad-id>

# Admin/operator only: expose the provider token(s) needed by this squad.
# This renders selected values into the squad's sandbox .ficus/.env file,
# so treat it as explicit access.
ficus squad-env expose-secrets <squad-id> DEPLOY_VERCEL_TOKEN
```

## Deployment records

Before and after external provider deployments, inspect, record, and maintain Ficus deployment records. Do not store secrets in metadata.

```bash
# Inspect existing deployment records first.
ficus deploy external list <squad-id>
ficus deploy external get <deployment-id>

# Record/update provider deployments.
ficus deploy external record <squad-id> --name <deployment-name> --provider github-pages --environment production --status ready --url <deployed-url> --provider-project-url <repo-or-actions-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
ficus deploy external update <deployment-id> --status ready --url <new-url>
```

Update the record whenever the URL/status changes, a deployment fails, a rollback happens, or the deployment is destroyed. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

## Provider-specific skills

Use repository files and build behavior to infer provider fit. Treat the matrix above as guidance, not a hard compatibility gate. Prefer GitHub Pages first for static sites because it is usually simpler than Netlify or Cloudflare. If the best target is ambiguous, explain tradeoffs and ask the human.

File-presence hints:

- `next.config.*`, `app/`, `pages/`, or a `next` dependency often indicate Next.js.
- `vite.config.*`, `src/main.*`, and `index.html` often indicate Vite/SPAs.
- `astro.config.*`, `svelte.config.*`, `nuxt.config.*`, or `remix.config.*` indicate those frameworks.
- `public/`, `dist/`, `build/`, and plain `index.html` are static-site candidates.
- `server.js`, `src/server.*`, or `express`/`fastify`/`hono`/`koa` dependencies indicate Node/API services.
- `Dockerfile` or `docker-compose.yml` indicates a container/custom runtime candidate.
- `supabase/config.toml`, `supabase/functions`, or `supabase/migrations` indicate Supabase companion work.
- `wrangler.toml` or `wrangler.json` indicates Cloudflare Pages/Workers.

Read the matching provider skill for concrete CLI steps:

- `deploy-vercel` — Vercel for Next.js and SPAs.
- `deploy-github-pages` — first-choice default for static exports and simple SPAs.
- `deploy-netlify` — Netlify for static sites/SPAs that need Netlify features or functions.
- `deploy-cloudflare` — Cloudflare Pages/Workers for static, SPA, and edge apps that need Cloudflare features.
- `deploy-railway` — Railway for APIs, containers, and managed services.
- `deploy-supabase` — Supabase for Postgres/auth/storage/functions companion services.
- `deploy-digitalocean` — DigitalOcean App Platform, containers, APIs, and databases.

## External provider commands

Install reusable CLIs in the shared runtime with `squad_bash` and Devbox where possible:

```bash
devbox add nodejs bun gh vercel netlify-cli railway wrangler supabase-cli doctl
```

Use provider local app/staging environments before production. Always verify the final public URL with `curl` or the provider CLI; do not assume a successful deploy means the URL is reachable.

Handoff checklist after deployment:

- Provider, project/site/service name, and environment.
- Final public URL and verification result.
- Ficus deployment record id.
- Cost/cleanup notes and destroy/remove command or dashboard path.
- Rollback command/path.
- Logs/status commands.
- Files changed for deploy compatibility.
- Secret handling notes without token values.

Do not create provider projects, public deployments, domains, always-on services, managed databases, or paid resources without explicit human approval.
