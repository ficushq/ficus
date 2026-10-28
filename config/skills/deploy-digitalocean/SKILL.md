---
name: deploy-digitalocean
description: Deploy APIs, containers, databases, or App Platform services to DigitalOcean with explicit billing and public exposure consent.
---

# Deploying with DigitalOcean

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App is an API/backend, container, or database-backed service suited for App Platform or managed databases.
- App files suggest DigitalOcean is a good fit (API/backend, container, App Platform spec, or managed database needs).
- The human approves account/project/app/database creation and cost risk.

## Guardrails

- Ask before creating apps, droplets, managed databases, load balancers, domains, or always-on paid resources.
- Requires a healthy DigitalOcean integration account assigned to this squad. If unauthenticated, ask a person to connect or assign it in Settings → Integrations.
- Never read, print, log, commit, or write integration credentials to files; use the assigned CLI or integration exec.
- Ask before production deploys and any database migration.

## Connect and assign

If no healthy account is assigned, walk the human through account setup before attempting CLI commands:

1. Ask them to sign in or create a DigitalOcean account at https://cloud.digitalocean.com/registrations/new.
2. Ask them to choose or create the project/account that should own the app. Mention that App Platform services, databases, droplets, load balancers, and domains can create billing charges.
3. Direct them to API → Tokens/Keys: https://cloud.digitalocean.com/account/api/tokens.
4. Ask them to generate a personal access token named `ficus-deploy`. Use the least privilege DigitalOcean offers for the intended resources; include account read access for validation and write access for app creation/update.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → DigitalOcean**, enable the integration, and have them create a named account with the token, then validate and enable it. Saved tokens remain hidden; replace the token on that account to rotate it.

6. Ask an admin/operator to assign the account in this squad’s **Integrations** tab and choose its default account. Existing imported accounts start unassigned.
7. Verify access without inspecting credentials: `doctl account get`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. If using Docker or source uploads, add `.dockerignore` or provider ignore settings as a fallback to exclude unrelated local files. Validate the App Platform spec from the app/repo directory.

## CLI setup

The assigned integration provisions the pinned `doctl` CLI and its PATH wrapper. Check readiness with `doctl version`; if unavailable, ask a person to check assignment/provisioning rather than installing an unwrapped global CLI.

For project-local CLIs (including npm/bun/pnpm scripts and npx/bunx), wrap the entire command explicitly:

```bash
ficus integration exec digitalocean -- npm run deploy
ficus integration exec digitalocean -- bun run deploy
ficus integration exec digitalocean -- pnpm run deploy
```

For an alternate assigned account use `ficus integration exec digitalocean --connection <connection-id> -- <command>`. Exec is unrestricted, but never use it to inspect or persist credentials. Human terminals receive no Ficus integration credentials; they may use their own CLI login.

## Safe flow

```bash
bun install
bun test
bun run build

# Inspect account/resources.
doctl account get
doctl apps list
doctl databases list

# Validate an App Platform spec before creating/updating.
doctl apps spec validate .do/app.yaml
```

## Production, rollback, cleanup

- Ask before `doctl apps create`, `doctl apps update`, domain changes, database creation, or scaling.
- Inspect deployments/logs with `doctl apps list-deployments <app-id>` and `doctl apps logs <app-id>`.
- Roll back using App Platform deployment controls or by redeploying a known-good spec/commit.
- Destroy apps/databases/domains only after explicit approval.

## Sources

- doctl official CLI repository/authentication: https://github.com/digitalocean/doctl
- App Platform deployment management: https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/
- `doctl apps spec validate`: https://docs.digitalocean.com/reference/doctl/reference/apps/spec/validate/
- `doctl apps logs`: https://docs.digitalocean.com/reference/doctl/reference/apps/logs/

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
