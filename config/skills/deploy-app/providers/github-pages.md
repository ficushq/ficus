# GitHub Pages

Read `deploy-app` first; this note holds only what differs for GitHub Pages. It is
the first choice for static sites, and unsuitable for server-rendered or API apps
without a static export.

- **Account:** no provider token. Use the squad's assigned GitHub integration
  account; never ask for a personal access token. The human connects GitHub and
  installs the GitHub App for the repository in **Settings → Integrations → GitHub**,
  then attaches the connection in the squad's **Integrations** tab.
- **Permissions:** administering Pages through the API needs the app's Pages read and
  write permission. If the shared app lacks it, use a custom GitHub App with it, or
  ask the human to configure Pages in GitHub. An Actions deployment uses the
  workflow's own `GITHUB_TOKEN` with `pages: write` and `id-token: write`.
- **CLI:** `gh` (`devbox add gh` if missing). Check access with `gh auth status`.
  For another attached account:
  `ficus integration exec github --squad <squad-id> --connection <connection-id> -- gh ...`.
- **Publish only the build output** (`dist`, `build`), never the workspace; point the
  workflow's artifact path at the app project.

```bash
gh repo view --json nameWithOwner,visibility,defaultBranchRef
gh api repos/{owner}/{repo}/pages || true
gh run list --limit 10
```

- Enabling Pages, changing repository settings and pushing to `gh-pages` need
  approval; a Pages site is public.
- Roll back by reverting the deployment commit or rerunning a known-good workflow.
  Disable Pages or delete `gh-pages` only after approval.
- Docs: https://docs.github.com/en/pages
