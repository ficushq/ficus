---
name: deploy-railway
description: Deploy API, container, or database-backed apps to Railway with explicit approval for always-on and managed resources.
---

# Deploying with Railway

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App is an API/backend, Dockerfile/custom runtime, or needs Railway-managed services.
- App files suggest Railway is a good fit (API/backend, long-running Node service, Dockerfile/custom runtime, or managed services).
- The human approves project/service creation, public domains, and potential always-on/egress billing.

## Guardrails

- Ask before creating projects/services/databases, provisioning always-on resources, setting public domains, or production deploys.
- Required Ficus secret: `DEPLOY_RAILWAY_TOKEN`. Do not paste tokens in chat.
- Ask a human admin/operator to expose only this secret in the Squad Settings tab → Environment section before running provider CLI commands.
- Ask before running migrations against Railway databases.
- Railway public services may incur usage/egress charges. Include cleanup notes in handoff.

## If `DEPLOY_RAILWAY_TOKEN` is not set

Walk the human through account/token setup before attempting CLI commands:

1. Ask them to sign in or create a Railway account at https://railway.com/login.
2. Ask them to choose or create the Railway workspace/project owner. Mention that services, databases, and always-on usage may affect billing.
3. Direct them to Railway Account Tokens: https://railway.com/account/tokens.
4. Ask them to create a token named `ficus-deploy`. In the workspace selector, specifically choose **No workspace** so Railway creates an **Account**-scoped token. Railway distinguishes project tokens (`RAILWAY_TOKEN`, project-level) from account/workspace tokens (`RAILWAY_API_TOKEN`, account-level). For Ficus project creation/listing/linking/deploy flows, use the account-scoped API token and store it as `DEPLOY_RAILWAY_TOKEN`.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Railway**, enable the integration, and have them save the token in its credential field. Saved tokens remain hidden; enter a replacement there to rotate it.

6. Ask an admin/operator to expose only `DEPLOY_RAILWAY_TOKEN` to this squad from the Squad Settings tab → Environment section. CLI fallback:

```bash
ficus squad-env expose-secrets <squad-id> DEPLOY_RAILWAY_TOKEN
```

7. Verify non-secret exposure with `ficus squad-env secrets <squad-id>`. Then verify Railway auth with `RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway whoami`.

## Token and environment troubleshooting

- Prefer `RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN"` for Railway CLI account/workspace/project creation flows. `RAILWAY_TOKEN` may be insufficient for project creation/listing and is more appropriate for project-level contexts.
- `ficus squad-env secrets <squad-id>` showing `isSet=true exposed=true` only proves Ficus has a secret and exposes it to the squad. It does **not** prove the current running process has the latest value or that Railway accepts the token.
- If Railway returns Unauthorized after a token was recently added/replaced, ask the human/admin to refresh/restart the agent/sandbox process so it receives the updated environment. Also verify the token is account-scoped, valid, and not revoked.
- Never put command strings containing `$DEPLOY_RAILWAY_TOKEN` inside double-quoted `ficus inbox` or `ficus workstream request-input` messages; Bash can expand and leak the secret. Use single quotes or heredocs when mentioning env-var syntax literally.

```bash
# Bad: may expand the secret before sending the message.
ficus workstream request-input <id> -m "Run RAILWAY_API_TOKEN=$DEPLOY_RAILWAY_TOKEN railway whoami"

# Good: keeps the env-var syntax literal.
ficus workstream request-input <id> -m 'Run RAILWAY_API_TOKEN=$DEPLOY_RAILWAY_TOKEN railway whoami'
```

## CLI setup

```bash
devbox add nodejs railway
railway --version
```

## Pre-deploy app checks

```bash
bun install
bun test
bun run build
```

- Ensure the app listens on the provider `PORT`, for example `Number(process.env.PORT ?? 3000)`.
- Test with a non-default port before deploy:

```bash
PORT=4173 timeout 5s bash -c 'bun run index.ts >/tmp/app-port.log 2>&1 & pid=$!; sleep 1; curl -sS http://127.0.0.1:4173/; kill $pid; wait $pid || true'
```

## Project directory and upload hygiene

Deploy from the app project's own directory, not the shared workspace root. In Ficus sandboxes, the workspace root often contains coordination files, local app logs, devbox state, docs, and other unrelated artifacts. If the app is currently at the workspace root, ask before moving it into a dedicated subdirectory such as `<workspace-root>/<app-name>` (your workspace root is the shared workspace path named in your system prompt) and run Railway commands from there.

Use `.railwayignore` as a secondary fallback before the first `railway up` so other unrelated files are not uploaded:

```bash
cat > .railwayignore <<'EOF'
.cache
.venv
docs
*.log
*.pid
EOF
```

## Naming

Use short, simple Railway project and service names. Prefer lowercase letters, numbers, and hyphens, and keep names concise (for example `<app-name>` or `<app-name>-api`). Railway may reject long names; if that happens, shorten the name and retry after confirming the shorter name is acceptable.

## Safe Railway flow

Use account-scoped auth for these commands:

```bash
# Auth/account inspection.
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway whoami
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway list

# Create/link project and service after explicit consent.
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway init -n <project-name> --json
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway add --service <service-name> --json
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway status

# Deploy after approval for the service/environment.
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway up --detach --message 'Deploy app'
```

Notes:

- `railway init` creates/links the project. Deploying with `railway up --service <name>` can fail with `Service not found` unless the service already exists; create it first with `railway add --service <service-name>`.
- Railpack may infer npm even for Bun apps but still detect/install Bun and run `npm run start`, which can call `bun run index.ts` successfully.

## Status, logs, and public domain

```bash
# Deployment polling and logs.
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway deployment list --json
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway logs --build <deployment-id> --lines 300
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway logs --latest --lines 100

# Generate a Railway public domain after successful deploy.
RAILWAY_API_TOKEN="$DEPLOY_RAILWAY_TOKEN" railway domain --service <service-name> --port <runtime-port> --json

# Verify externally.
curl -sS -w '\nHTTP_STATUS:%{http_code}\nCONTENT_TYPE:%{content_type}\n' https://<domain>/
```

## Production, rollback, cleanup

- Ask before production domains, paid plugins, or database migrations.
- Roll back by redeploying a known-good commit or using Railway deployment controls.
- Remove services/projects only after explicit approval.
- Include project name, service name, public URL, cost/cleanup notes, verification results, and logs/deployment commands in handoff.

## Sources

- Railway CLI overview and tokens: https://docs.railway.com/guides/cli
- Deploying with `railway up`: https://docs.railway.com/cli/deploying
- CLI command reference, including `logs`, `status`, and `list`: https://docs.railway.com/cli.md
- `railway list`: https://docs.railway.com/cli/list

## Ficus deployment record

After deploying, record the external deployment and keep it updated. Do not put secrets in metadata. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

```bash
ficus deploy external record <squad-id> --name <deployment-name> --provider railway --environment production --status ready --url <deployed-url> --provider-project-url <railway-project-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
```
