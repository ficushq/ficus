---
name: deploy-supabase
description: Use Supabase as a deployment companion for Postgres, auth, storage, or edge functions with migration and billing guardrails.
---

# Deploying with Supabase

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App needs managed Postgres, auth, storage, realtime, or Supabase Edge Functions.
- App files suggest Supabase is a good fit (Supabase config, migrations, Edge Functions, or Postgres/auth/storage needs).
- Supabase is often a companion service, not the primary web host.

## Guardrails

- Ask before creating projects, linking production projects, applying migrations, exposing functions, enabling paid features, or changing auth/storage policies.
- Required Ficus secret: `DEPLOY_SUPABASE_TOKEN`. Do not paste tokens in chat.
- Ask a human admin/operator to expose only this secret in squad Environment settings or with `ficus squad-env expose-secrets <squad-id> DEPLOY_SUPABASE_TOKEN` before running provider CLI commands.
- Never run non-local database migrations without explicit human approval.

## If `DEPLOY_SUPABASE_TOKEN` is not set

Walk the human through account/token setup before attempting CLI commands:

1. Ask them to sign in or create a Supabase account at https://supabase.com/dashboard/sign-up.
2. Ask them to choose or create the organization/project owner. Mention that projects, database size, storage, egress, and edge functions may affect billing.
3. Direct them to Account → Access Tokens: https://supabase.com/dashboard/account/tokens.
4. Ask them to create a token named `ficus-deploy`.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Supabase**, enable the integration, and have them save the token in its credential field. Saved tokens remain hidden; enter a replacement there to rotate it.

6. Ask an admin/operator to expose only `DEPLOY_SUPABASE_TOKEN` to this squad from the Squad Settings tab → Environment section. CLI fallback:

```bash
ficus squad-env expose-secrets <squad-id> DEPLOY_SUPABASE_TOKEN
```

7. Verify non-secret access with `ficus squad-env secrets <squad-id>` and then `SUPABASE_ACCESS_TOKEN="$DEPLOY_SUPABASE_TOKEN" supabase projects list`.

## Project directory hygiene

Run Supabase commands from the app/repo directory that contains `supabase/config.toml` and migrations, not the shared workspace root. Confirm the linked project and migration directory before applying anything outside local development.

## CLI setup

```bash
devbox add nodejs supabase-cli
supabase --version
```

## Safe flow

```bash

# Local checks first.
supabase status || true
supabase db diff || true
bun test

# Inspect/link only after project consent.
SUPABASE_ACCESS_TOKEN="$DEPLOY_SUPABASE_TOKEN" supabase projects list
SUPABASE_ACCESS_TOKEN="$DEPLOY_SUPABASE_TOKEN" supabase link --project-ref <ref>

# Review before applying.
SUPABASE_ACCESS_TOKEN="$DEPLOY_SUPABASE_TOKEN" supabase migration list
SUPABASE_ACCESS_TOKEN="$DEPLOY_SUPABASE_TOKEN" supabase functions list
```

## Production, rollback, cleanup

- Ask before `supabase db push`, `supabase functions deploy`, auth policy changes, or storage bucket changes.
- Roll back via reviewed reverse migrations/backups or redeploy previous function versions.
- Deleting projects/buckets/functions requires explicit approval.

## Sources

- Supabase CLI reference: https://supabase.com/docs/reference/cli/introduction
- Supabase project linking: https://supabase.com/docs/reference/cli/supabase-link
- Managing environments and `SUPABASE_ACCESS_TOKEN`: https://supabase.com/docs/guides/deployment/managing-environments
- Local development and migrations: https://supabase.com/docs/guides/local-development/overview

## Ficus deployment record

After deploying, record the external deployment and keep it updated. Do not put secrets in metadata. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

```bash
ficus deploy external record <squad-id> --name <deployment-name> --provider <provider-id> --environment production --status ready --url <deployed-url> --provider-project-url <provider-dashboard-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
```
