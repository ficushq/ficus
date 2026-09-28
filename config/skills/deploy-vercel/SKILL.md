---
name: deploy-vercel
description: Deploy static, Vite/SPA, or Next.js apps to Vercel after Ficus local app, tests, and explicit human consent.
---

# Deploying with Vercel

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App is a Next.js app or frontend SPA/static site.
- App files suggest Vercel is a good fit (for example Next.js, Vite/SPA, or static frontend).
- The human has approved creating/linking a Vercel project and any public URL or production deploy.

## Guardrails

- Ask before project creation, production deployment, domain changes, paid features, or public exposure.
- Required Ficus secret: `DEPLOY_VERCEL_TOKEN`. Do not ask users to paste it in chat.
- Ask a human admin/operator to expose only this secret in squad Environment settings or with `ficus squad-env expose-secrets <squad-id> DEPLOY_VERCEL_TOKEN` before running provider CLI commands.
- Do not store secrets in `.env` unless the human explicitly approves and they are needed by the app.

## If `DEPLOY_VERCEL_TOKEN` is not set

Walk the human through account/token setup before attempting CLI commands:

1. Ask them to sign in or create a Vercel account at https://vercel.com/signup.
2. Ask them to choose or create the Vercel team/account that should own the project. Mention that team-owned projects may have billing implications.
3. Direct them to Vercel Account Settings → Tokens: https://vercel.com/account/settings/tokens.
4. Ask them to create a token named `ficus-deploy` with the minimum practical scope for the intended account/team.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Vercel**, enable the integration, and have them save the token in its credential field. Saved tokens remain hidden; enter a replacement there to rotate it.

6. Ask an admin/operator to expose only `DEPLOY_VERCEL_TOKEN` to this squad from the Squad Settings tab → Environment section. CLI fallback:

```bash
ficus squad-env expose-secrets <squad-id> DEPLOY_VERCEL_TOKEN
```

7. Verify non-secret access with `ficus squad-env secrets <squad-id>` and then `VERCEL_TOKEN="$DEPLOY_VERCEL_TOKEN" vercel whoami`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. If uploading source with Vercel, add `.vercelignore` as a fallback to exclude unrelated local files. For static builds, verify the build output directory before deploying.

## CLI setup

```bash
devbox add nodejs vercel
vercel --version
```

## Safe flow

```bash
# Inspect first.
bun install
bun run build

# Link only after consent to use/create the Vercel project.
VERCEL_TOKEN="$DEPLOY_VERCEL_TOKEN" vercel link
VERCEL_TOKEN="$DEPLOY_VERCEL_TOKEN" vercel project ls

# Preview deploy first.
VERCEL_TOKEN="$DEPLOY_VERCEL_TOKEN" vercel deploy

# Inspect status/logs.
VERCEL_TOKEN="$DEPLOY_VERCEL_TOKEN" vercel ls
VERCEL_TOKEN="$DEPLOY_VERCEL_TOKEN" vercel logs <deployment-url-or-id>
```

## Production, rollback, cleanup

- Ask for explicit human approval before `vercel deploy --prod` or domain changes.
- Roll back production deployments with `vercel rollback <deployment-url>` or the Vercel dashboard after approval.
- Cleanup deployments with `vercel remove <deployment-url-or-id>` or remove projects via Vercel project controls only after explicit approval.

## Sources

- Vercel CLI overview: https://vercel.com/docs/cli
- `vercel deploy`: https://vercel.com/docs/cli/deploy
- `vercel logs`: https://vercel.com/docs/cli/logs
- `vercel rollback`: https://vercel.com/docs/cli/rollback
- `vercel remove` / project commands: https://vercel.com/docs/cli/remove and https://vercel.com/docs/cli/project

## Ficus deployment record

After deploying, record the external deployment and keep it updated. Do not put secrets in metadata. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

```bash
ficus deploy external record <squad-id> --name <deployment-name> --provider <provider-id> --environment production --status ready --url <deployed-url> --provider-project-url <provider-dashboard-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
```
