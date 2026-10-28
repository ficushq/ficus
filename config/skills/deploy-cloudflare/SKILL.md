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
- Requires a healthy Cloudflare integration account assigned to this squad. If unauthenticated, ask a person to connect or assign it in Settings → Integrations.
- Never read, print, log, commit, or write integration credentials to files; use the assigned CLI or integration exec.

## Connect and assign

If no healthy account is assigned, walk the human through account setup before attempting CLI commands:

1. Ask them to sign in or create a Cloudflare account at https://dash.cloudflare.com/sign-up.
2. Ask them to choose the Cloudflare account that should own the Pages project or Worker. Mention that routes, custom domains, KV/R2/D1, and Workers usage may affect billing.
3. Direct them to My Profile → API Tokens → Create Token: https://dash.cloudflare.com/profile/api-tokens.
4. Prefer a custom token named `ficus-deploy` with only the needed permissions. Typical starting points:
   - Cloudflare Pages: Account → Cloudflare Pages: Edit, Account → Account Settings: Read.
   - Workers: Account → Workers Scripts: Edit, Account → Account Settings: Read.
   - Add Zone permissions only if they explicitly approve routes/domains/DNS.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Cloudflare**, enable the integration, and have them create a named account with the token, then validate and enable it. Saved tokens remain hidden; replace the token on that account to rotate it.

Set the optional, nonsecret Cloudflare account ID on the connection when needed; it is delivered only to each command.

6. Ask an admin/operator to assign the account in this squad’s **Integrations** tab and choose its default account. Existing imported accounts start unassigned.
7. Verify access without inspecting credentials: `wrangler whoami`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. For Pages, deploy the explicit build output directory, for example `wrangler pages deploy dist`. For Workers, run Wrangler from the Worker project directory. Use ignore files only as a fallback.

## CLI setup

The assigned integration provisions the pinned `wrangler` CLI and its PATH wrapper. Check readiness with `wrangler --version`; if unavailable, ask a person to check assignment/provisioning rather than installing an unwrapped global CLI.

For project-local CLIs (including npm/bun/pnpm scripts and npx/bunx), wrap the entire command explicitly:

```bash
ficus integration exec cloudflare -- npm run deploy
```

For an alternate assigned account use `ficus integration exec cloudflare --connection <connection-id> -- <command>`. Exec is unrestricted, but never use it to inspect or persist credentials. Human terminals receive no Ficus integration credentials; they may use their own CLI login.

## Safe flow

```bash
bun install
bun run build

# Inspect account/project state.
wrangler whoami

# Pages preview/project deploy, after project consent; adjust dist path.
wrangler pages project list
wrangler pages deploy dist --project-name <name> --branch preview

# Worker dry run/local checks where applicable.
wrangler deploy --dry-run
wrangler tail <worker-name>
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
