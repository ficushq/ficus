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
- Requires a healthy Vercel integration account assigned to this squad. If unauthenticated, ask a person to connect or assign it in Settings → Integrations.
- Never read, print, log, commit, or write integration credentials to files; use the assigned CLI or integration exec.
- Custom app configuration may live in project files as directed by the human; integration credentials must never be written there.

## Connect and assign

If no healthy account is assigned, walk the human through account setup before attempting CLI commands:

1. Ask them to sign in or create a Vercel account at https://vercel.com/signup.
2. Ask them to choose or create the Vercel team/account that should own the project. Mention that team-owned projects may have billing implications.
3. Direct them to Vercel Account Settings → Tokens: https://vercel.com/account/settings/tokens.
4. Ask them to create a token named `ficus-deploy` with the minimum practical scope for the intended account/team.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Vercel**, enable the integration, and have them create a named account with the token, then validate and enable it. Saved tokens remain hidden; replace the token on that account to rotate it.

6. Ask an admin/operator to assign the account in this squad’s **Integrations** tab and choose its default account. Existing imported accounts start unassigned.
7. Verify access without inspecting credentials: `vercel whoami`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. If uploading source with Vercel, add `.vercelignore` as a fallback to exclude unrelated local files. For static builds, verify the build output directory before deploying.

## CLI setup

The assigned integration provisions the pinned `vercel` CLI and its PATH wrapper. Check readiness with `vercel --version`; if unavailable, ask a person to check assignment/provisioning rather than installing an unwrapped global CLI.

For project-local CLIs (including npm/bun/pnpm scripts and npx/bunx), wrap the entire command explicitly:

```bash
ficus integration exec vercel -- npm run deploy
ficus integration exec vercel -- bun run deploy
ficus integration exec vercel -- pnpm run deploy
```

For an alternate assigned account use `ficus integration exec vercel --connection <connection-id> -- <command>`. Exec is unrestricted, but never use it to inspect or persist credentials. Human terminals receive no Ficus integration credentials; they may use their own CLI login.

## Safe flow

```bash
# Inspect first.
bun install
bun run build

# Link only after consent to use/create the Vercel project.
vercel link
vercel project ls

# Preview deploy first.
vercel deploy

# Inspect status/logs.
vercel ls
vercel logs <deployment-url-or-id>
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

## Runtime context and custom configuration

The squad runtime supplies `FICUS_SQUAD_ID`; outside that context add
`--squad <squad-id>` before `--`. This selector does not grant authorization.
On the host runtime, the operator must install the real CLI; managed wrappers
still provide per-command authentication. Never replace them with token exports.
Custom app secrets may use squad **Environment Variables** (visible to agents and
terminals) or human-directed files in the squad or agent workspace. Integration
credentials must never be copied into those locations or persistent processes.
