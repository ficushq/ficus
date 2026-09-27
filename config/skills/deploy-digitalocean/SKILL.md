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
- Required Ficus secret: `DEPLOY_DIGITALOCEAN_TOKEN`. Do not paste tokens in chat.
- Ask a human admin/operator to expose only this secret in squad Environment settings or with `ficus squad-env expose-secrets <squad-id> DEPLOY_DIGITALOCEAN_TOKEN` before running provider CLI commands.
- Ask before production deploys and any database migration.

## If `DEPLOY_DIGITALOCEAN_TOKEN` is not set

Walk the human through account/token setup before attempting CLI commands:

1. Ask them to sign in or create a DigitalOcean account at https://cloud.digitalocean.com/registrations/new.
2. Ask them to choose or create the project/account that should own the app. Mention that App Platform services, databases, droplets, load balancers, and domains can create billing charges.
3. Direct them to API → Tokens/Keys: https://cloud.digitalocean.com/account/api/tokens.
4. Ask them to generate a personal access token named `ficus-deploy`. Use the least privilege DigitalOcean offers for the intended resources; write access is required for app creation/update.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → DigitalOcean**, enable the integration, and have them save the token in its credential field. Saved tokens remain hidden; enter a replacement there to rotate it.

6. Ask an admin/operator to expose only `DEPLOY_DIGITALOCEAN_TOKEN` to this squad from the Squad Settings tab → Environment section. CLI fallback:

```bash
ficus squad-env expose-secrets <squad-id> DEPLOY_DIGITALOCEAN_TOKEN
```

7. Verify non-secret access with `ficus squad-env secrets <squad-id>` and then `DIGITALOCEAN_ACCESS_TOKEN="$DEPLOY_DIGITALOCEAN_TOKEN" doctl account get`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. If using Docker or source uploads, add `.dockerignore` or provider ignore settings as a fallback to exclude unrelated local files. Validate the App Platform spec from the app/repo directory.

## CLI setup

```bash
devbox add doctl
doctl version
```

## Safe flow

```bash
bun install
bun test
bun run build

# Inspect account/resources.
DIGITALOCEAN_ACCESS_TOKEN="$DEPLOY_DIGITALOCEAN_TOKEN" doctl account get
DIGITALOCEAN_ACCESS_TOKEN="$DEPLOY_DIGITALOCEAN_TOKEN" doctl apps list
DIGITALOCEAN_ACCESS_TOKEN="$DEPLOY_DIGITALOCEAN_TOKEN" doctl databases list

# Validate an App Platform spec before creating/updating.
DIGITALOCEAN_ACCESS_TOKEN="$DEPLOY_DIGITALOCEAN_TOKEN" doctl apps spec validate .do/app.yaml
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
