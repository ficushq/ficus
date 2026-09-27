---
name: deploy-github-pages
description: Publish static sites to GitHub Pages after build verification and explicit approval for public repository/page exposure.
---

# Deploying with GitHub Pages

## Command runtime

For squad project work, invoke the following project-directory commands through `squad_bash` from the shared app/repository directory. This includes `devbox add`, dependency install, build/test, provider CLI, Docker, local servers, deployment, diagnostics, and cleanup. If `squad_bash` is unavailable, use the shell capability described by the agent’s Workspace & Sandbox prompt.

## Use when

- App is static HTML/CSS/JS or an SPA that builds to static assets.
- App files suggest GitHub Pages is a good fit (simple static site/docs or SPA with static export).
- Repository ownership, Pages visibility, and branch/source are approved by the human.

## Guardrails

- Ask before enabling Pages, changing repository settings, creating public pages, or pushing deployment commits.
- Use the squad's assigned GitHub integration account. Never ask for a personal access token.
- GitHub Pages is not suitable for server-rendered/API apps without a static export.

## GitHub account setup

1. In Ficus Settings → Integrations → GitHub, connect the account and install the GitHub App for the approved repository.
2. In Squad Settings → Integrations, attach that connection and choose the default account.
3. For Pages API administration, the installed app needs Pages read/write permission. If unavailable on the shared app, use a custom GitHub App with that permission or ask the human to configure Pages in GitHub. Actions-based deployment uses the workflow's scoped `GITHUB_TOKEN` and `pages: write` / `id-token: write` permissions.
4. Verify access with `gh auth status` and `gh repo view`. Ficus resolves the current integration credential for each command. For another attached account, use `ficus integration exec github --squad <squad-id> --connection <connection-id> -- gh ...`.

## Project directory and upload hygiene

Build from the app project directory, not the shared workspace root. Publish only the static build output (`dist`, `build`, or configured artifact), never the entire workspace. If using GitHub Actions, ensure the workflow path and artifact directory point at the app project.

## CLI setup

```bash
devbox add gh git nodejs
gh --version
```

## Safe flow

```bash
bun install
bun run build

# Inspect repository and Pages status using the assigned integration account.
gh repo view --json nameWithOwner,visibility,defaultBranchRef
gh api repos/{owner}/{repo}/pages || true

# If using GitHub Actions, inspect workflow status.
gh run list --limit 10
```

## Publish, rollback, cleanup

- Ask before enabling Pages via repository settings/API or pushing to `gh-pages`.
- Common patterns: GitHub Actions uploads `dist`, or a dedicated `gh-pages` branch contains build output.
- Roll back by reverting the deployment commit or rerunning a known-good workflow.
- Disable Pages or remove the `gh-pages` branch only after explicit approval.

## Sources

- GitHub Pages documentation: https://docs.github.com/en/pages
- Configuring a publishing source: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- GitHub Pages with GitHub Actions: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- GitHub CLI manual and environment variables: https://cli.github.com/manual/ and https://cli.github.com/manual/gh_help_environment

## Ficus deployment record

After deploying, record the external deployment and keep it updated. Do not put secrets in metadata. Archive old or superseded external deployment records once they are no longer useful; archived records move out of the active Apps tab list while preserving history.

```bash
ficus deploy external record <squad-id> --name <deployment-name> --provider <provider-id> --environment production --status ready --url <deployed-url> --provider-project-url <provider-dashboard-url>
ficus deploy external update <deployment-id> --status failed
ficus deploy external archive <deployment-id>
```
