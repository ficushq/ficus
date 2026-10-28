---
name: deploy-netlify
description: Deploy static sites and SPAs to Netlify after Ficus local app, tests, and explicit human consent.
---

# Deploying with Netlify

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App is static HTML/CSS/JS or a Vite/React SPA.
- App files suggest Netlify is a good fit (for example static HTML/CSS/JS, Vite/React SPA, Astro, or Jamstack app).
- The human has approved site creation/linking and public preview URLs.

## Guardrails

- Ask before site creation, production deploy, domain/DNS changes, paid add-ons, or public exposure.
- Requires a healthy Netlify integration account assigned to this squad. If unauthenticated, ask a person to connect or assign it in Settings → Integrations.
- Never read, print, log, commit, or write integration credentials to files; use the assigned CLI or integration exec.

## Connect and assign

If no healthy account is assigned, walk the human through account setup before attempting CLI commands:

1. Ask them to sign in or create a Netlify account at https://app.netlify.com/signup.
2. Ask them to choose or create the Netlify team that should own the site. Mention that team features/add-ons can affect billing.
3. Direct them to User Settings → Applications → Personal access tokens: https://app.netlify.com/user/applications#personal-access-tokens.
4. Ask them to create a token named `ficus-deploy`.
5. Do **not** ask them to paste the token in chat. Open Ficus **Settings → Integrations → Netlify**, enable the integration, and have them create a named account with the token, then validate and enable it. Saved tokens remain hidden; replace the token on that account to rotate it.

6. Ask an admin/operator to assign the account in this squad’s **Integrations** tab and choose its default account. Existing imported accounts start unassigned.
7. Verify access without inspecting credentials: `netlify sites:list`.

## Project directory and upload hygiene

Deploy from the app project directory, not the shared workspace root. Prefer deploying the explicit build output with `netlify deploy --dir <build-output>`. Add `.netlifyignore` as a fallback if source uploads include unrelated local files.

## CLI setup

The assigned integration provisions the pinned `netlify` CLI and its PATH wrapper. Check readiness with `netlify --version`; if unavailable, ask a person to check assignment/provisioning rather than installing an unwrapped global CLI.

For project-local CLIs (including npm/bun/pnpm scripts and npx/bunx), wrap the entire command explicitly:

```bash
ficus integration exec netlify -- npm run deploy
```

For an alternate assigned account use `ficus integration exec netlify --connection <connection-id> -- <command>`. Exec is unrestricted, but never use it to inspect or persist credentials. Human terminals receive no Ficus integration credentials; they may use their own CLI login.

## Safe flow

```bash
bun install
bun run build

# Link/create only after consent.
netlify sites:list
netlify link

# Draft deploy first; adjust --dir to the app build output.
netlify deploy --dir dist

# Inspect.
netlify status
netlify deploy:list
netlify open:admin
```

## Production, rollback, cleanup

- Ask before `netlify deploy --prod`, domain changes, or forms/functions that may incur usage.
- Roll back from Netlify deploy history after approval; verify the restored deploy in the Netlify UI.
- Delete sites only after explicit human approval.

## Sources

- Netlify CLI getting started: https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/
- Netlify CLI deploy command: https://cli.netlify.com/commands/deploy/
- Netlify CLI command reference: https://cli.netlify.com/
- Manage deploys and rollbacks: https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/

## Ficus deployment record

After deploying, record the external deployment and keep it updated. Do not put secrets in metadata. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

```bash
ficus deploy external record <squad-id> --name <deployment-name> --provider <provider-id> --environment production --status ready --url <deployed-url> --provider-project-url <provider-dashboard-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
```
