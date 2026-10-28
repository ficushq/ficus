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
- Requires a healthy Railway integration account assigned to this squad. If unauthenticated, ask a person to connect or assign it in Settings → Integrations.
- Never read, print, log, commit, or write integration credentials to files; use the assigned CLI or integration exec.
- Ask before running migrations against Railway databases.
- Railway public services may incur usage/egress charges. Include cleanup notes in handoff.

## Connect and assign

If no healthy account is assigned, walk the human through account setup before attempting CLI commands:

1. Ask them to sign in or create a Railway account at https://railway.com/login.
2. Ask them to choose or create the Railway workspace/project owner. Mention that services, databases, and always-on usage may affect billing.
3. Direct them to Railway Account Tokens: https://railway.com/account/tokens.
4. Ask them to create a token named `ficus-deploy`. In the workspace selector, specifically choose **No workspace** so Railway creates an **Account**-scoped token. Railway distinguishes project tokens (`RAILWAY_TOKEN`, project-level) from account/workspace tokens (`RAILWAY_API_TOKEN`, account-level). For Ficus project creation/listing/linking/deploy flows, use the account-scoped API token.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Railway**, enable the integration, and have them create a named account with the token, then validate and enable it. Saved tokens remain hidden; replace the token on that account to rotate it.

6. Ask an admin/operator to assign the account in this squad’s **Integrations** tab and choose its default account. Existing imported accounts start unassigned.
7. Verify access without inspecting credentials: `railway list`.

## Authentication troubleshooting

Use account/workspace API tokens, not project tokens. If authentication fails, ask a person to validate, enable or reconnect the assigned account. Exec obtains current credentials per command; do not restart the sandbox to pick up a token, and never inspect token variables.

## CLI setup

The assigned integration provisions the pinned `railway` CLI and its PATH wrapper. Check readiness with `railway --version`; if unavailable, ask a person to check assignment/provisioning rather than installing an unwrapped global CLI.

For project-local CLIs (including npm/bun/pnpm scripts and npx/bunx), wrap the entire command explicitly:

```bash
ficus integration exec railway -- npm run deploy
ficus integration exec railway -- bun run deploy
ficus integration exec railway -- pnpm run deploy
```

For an alternate assigned account use `ficus integration exec railway --connection <connection-id> -- <command>`. Exec is unrestricted, but never use it to inspect or persist credentials. Human terminals receive no Ficus integration credentials; they may use their own CLI login.

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
railway whoami
railway list

# Create/link project and service after explicit consent.
railway init -n <project-name> --json
railway add --service <service-name> --json
railway status

# Deploy after approval for the service/environment.
railway up --detach --message 'Deploy app'
```

Notes:

- `railway init` creates/links the project. Deploying with `railway up --service <name>` can fail with `Service not found` unless the service already exists; create it first with `railway add --service <service-name>`.
- Railpack may infer npm even for Bun apps but still detect/install Bun and run `npm run start`, which can call `bun run index.ts` successfully.

## Status, logs, and public domain

```bash
# Deployment polling and logs.
railway deployment list --json
railway logs --build <deployment-id> --lines 300
railway logs --latest --lines 100

# Generate a Railway public domain after successful deploy.
railway domain --service <service-name> --port <runtime-port> --json

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

## Runtime context and custom configuration

The squad runtime supplies `FICUS_SQUAD_ID`; outside that context add
`--squad <squad-id>` before `--`. This selector does not grant authorization.
On the host runtime, the operator must install the real CLI; managed wrappers
still provide per-command authentication. Never replace them with token exports.
Custom app secrets may use squad **Environment Variables** (visible to agents and
terminals) or human-directed files in the squad or agent workspace. Integration
credentials must never be copied into those locations or persistent processes.
