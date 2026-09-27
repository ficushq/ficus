---
name: deploy-cloudflare
description: Deploy static/SPAs to Cloudflare Pages or edge apps to Workers with explicit consent and token guardrails.
---

# Deploying with Cloudflare

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App is static, SPA, or Worker/edge runtime compatible.
- App files suggest Cloudflare is a good fit (for example static/SPA output, Pages Functions, Workers, or `wrangler.*`).
- The human approves Cloudflare project creation and public exposure.

## Guardrails

- Ask before Pages/Workers project creation, production deploy, routes/domains/DNS, public egress, KV/R2/D1, or paid features.
- Required Ficus secret: `DEPLOY_CLOUDFLARE_TOKEN`. Do not paste tokens in chat.
- Ask a human admin/operator to expose only this secret in squad Environment settings or with `ficus squad-env expose-secrets <squad-id> DEPLOY_CLOUDFLARE_TOKEN` before running provider CLI commands.

## If `DEPLOY_CLOUDFLARE_TOKEN` is not set

Walk the human through account/token setup before attempting CLI commands:

1. Ask them to sign in or create a Cloudflare account at https://dash.cloudflare.com/sign-up.
2. Ask them to choose the Cloudflare account that should own the Pages project or Worker. Mention that routes, custom domains, KV/R2/D1, and Workers usage may affect billing.
3. Direct them to My Profile → API Tokens → Create Token: https://dash.cloudflare.com/profile/api-tokens.
4. Prefer a custom token named `ficus-deploy` with only the needed permissions. Typical starting points:
   - Cloudflare Pages: Account → Cloudflare Pages: Edit, Account → Account Settings: Read.
   - Workers: Account → Workers Scripts: Edit, Account → Account Settings: Read.
   - Add Zone permissions only if they explicitly approve routes/domains/DNS.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Cloudflare**, enable the integration, and have them save the token in its credential field. Saved tokens remain hidden; enter a replacement there to rotate it.

6. Ask an admin/operator to expose only `DEPLOY_CLOUDFLARE_TOKEN` to this squad from the Squad Settings tab → Environment section. CLI fallback:

```bash
ficus squad-env expose-secrets <squad-id> DEPLOY_CLOUDFLARE_TOKEN
```

7. Verify non-secret access with `ficus squad-env secrets <squad-id>` and then `CLOUDFLARE_API_TOKEN="$DEPLOY_CLOUDFLARE_TOKEN" wrangler whoami`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. For Pages, deploy the explicit build output directory, for example `wrangler pages deploy dist`. For Workers, run Wrangler from the Worker project directory. Use ignore files only as a fallback.

## CLI setup

```bash
devbox add nodejs wrangler
wrangler --version
```

## Safe flow

```bash
bun install
bun run build

# Inspect account/project state.
CLOUDFLARE_API_TOKEN="$DEPLOY_CLOUDFLARE_TOKEN" wrangler whoami

# Pages preview/project deploy, after project consent; adjust dist path.
CLOUDFLARE_API_TOKEN="$DEPLOY_CLOUDFLARE_TOKEN" wrangler pages project list
CLOUDFLARE_API_TOKEN="$DEPLOY_CLOUDFLARE_TOKEN" wrangler pages deploy dist --project-name <name> --branch preview

# Worker dry run/local checks where applicable.
CLOUDFLARE_API_TOKEN="$DEPLOY_CLOUDFLARE_TOKEN" wrangler deploy --dry-run
CLOUDFLARE_API_TOKEN="$DEPLOY_CLOUDFLARE_TOKEN" wrangler tail <worker-name>
```

## Production, rollback, cleanup

- Ask before production branch deploys, custom domains/routes, or resource bindings.
- Roll back via Pages deployments or Workers Versions/Deployments controls.
- Delete Pages projects, Workers, routes, or data resources only after explicit approval.

## Sources

- Wrangler CLI overview: https://developers.cloudflare.com/workers/wrangler/
- Wrangler commands, including deploy/tail/versions: https://developers.cloudflare.com/workers/wrangler/commands/
- Cloudflare Pages API/deployments and token permissions: https://developers.cloudflare.com/pages/configuration/api/
- Cloudflare Wrangler Action examples for `pages project list` and `pages deploy`: https://github.com/cloudflare/wrangler-action

## Ficus deployment record

After deploying, record the external deployment and keep it updated. Do not put secrets in metadata. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

```bash
ficus deploy external record <squad-id> --name <deployment-name> --provider <provider-id> --environment production --status ready --url <deployed-url> --provider-project-url <provider-dashboard-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
```
