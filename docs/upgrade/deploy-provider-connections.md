# Deployment provider accounts: upgrade notes

Cloudflare, DigitalOcean, Netlify, Railway, Supabase and Vercel now use named integration accounts. In **Settings → Integrations**, connect, validate and enable an account, then assign it in each squad’s **Integrations** tab. Multiple accounts can be attached; choose a default or select an attached account explicitly with integration exec. A global default is available for squads that opt into inheritance; importing a token never opts a squad in.

## Existing installations: action required

The upgrade automatically imports each existing `DEPLOY_CLOUDFLARE_TOKEN`, `DEPLOY_DIGITALOCEAN_TOKEN`, `DEPLOY_NETLIFY_TOKEN`, `DEPLOY_RAILWAY_TOKEN`, `DEPLOY_SUPABASE_TOKEN` and `DEPLOY_VERCEL_TOKEN` into an encrypted connection. **Imported accounts are disabled, pending validation and UNASSIGNED.** Validate and enable them, then assign only the squads that should use them. Exposure choices and global/squad defaults are **not** copied. Arbitrary exposed values are not migrated.

Both encrypted stored values and environment-only values are imported; the stored value wins if both exist (including an empty stored tombstone). Remove the obsolete `DEPLOY_*_TOKEN` variables from the Core host environment after upgrading. These six names are ignored from this version onward, including when a stored row is deleted; they cannot restore the old lookup/export path.

Each provider has a durable per-provider migration marker, written even if no token exists. Importing the encrypted credential, creating its connection, writing the marker and deleting its old stored key happen in one transaction. Concurrent starts serialize on the marker. A failure before commit preserves the source for a later startup retry; a failure after commit retries cache reconciliation, not credential creation. Once marked, subsequent starts never overwrite a rotated/reauthorized account or recreate a deleted connection, even if the host variable remains set. Migration performs no provider API calls. A missing encryption key or a per-provider import failure logs a warning without aborting startup. A failed conversion retains its encrypted source and no completed marker; a post-commit reconciliation failure instead retains the completed marker and retries only reconciliation. Other providers continue. After a migration warning, resolve the underlying storage/encryption failure and restart; do not delete markers to retry an already committed import.

The retired deployment-settings endpoints and deployment catalog mode are removed. Operator secret commands and unrelated storage remain available, but the six retired deployment names are no longer an authentication configuration surface.

## Per-command credentials and configuration

Integration credentials are fetched fresh for each command via `ficus integration exec`; Ficus does not write them into sandbox files, shell initialization, agent environments or terminal environments. Assigned globally provisioned CLIs use PATH wrappers, including nested child processes on Docker, Kubernetes, VM and host runtimes. Unassigning or disabling an account/provider revokes exec access immediately; wrappers are reconciled with assignment.

Project-local CLIs and package managers can precede the global wrappers. Wrap the entire script instead:

```sh
ficus integration exec vercel -- npm run deploy
ficus integration exec vercel --connection <attached-account-id> -- npm run deploy
```

Agent commands use the current squad context. When invoking exec outside a managed squad context, provide `--squad <squad-id>` before `--`. Exec remains unrestricted: never use it to read, print, log or persist an integration token. Human terminal wrappers pass through to the real binary with a notice and no Ficus credentials; people can use their own CLI login.

The optional Cloudflare account ID is nonsecret **connection configuration**. It travels as `CLOUDFLARE_ACCOUNT_ID` only through exec alongside that account, not a global sandbox binding. Project/site/organization selections otherwise remain project-local CLI configuration or explicit flags. DigitalOcean exec uses the default CLI context so a previously selected local context cannot override its assigned token. Railway accepts account/workspace API tokens, not project tokens. DigitalOcean tokens need account read permission for validation as well as deployment permissions; Cloudflare validation uses the user API-token verification endpoint.

Host runtime does not provision CLIs: the operator must install the matching provider CLI on the host before using its wrapper.

## CLI pins and provenance

On managed runtimes the normal integration projection installs the CLI and attaches its matching `deploy-<provider>` skill. Releases are pinned in `apps/core/src/services/integrations/deployment/cli-releases.json`:

| Provider | CLI | Version | Exec token variable |
| --- | --- | --- | --- |
| Cloudflare | wrangler | 4.154.0 | `CLOUDFLARE_API_TOKEN` |
| DigitalOcean | doctl | 2.1.0 | `DIGITALOCEAN_ACCESS_TOKEN` |
| Netlify | netlify-cli (`netlify`) | 27.15.0 | `NETLIFY_AUTH_TOKEN` |
| Railway | railway | 5.71.0 | `RAILWAY_API_TOKEN` |
| Supabase | supabase | 2.122.0 | `SUPABASE_ACCESS_TOKEN` |
| Vercel | vercel | 65.5.0 | `VERCEL_TOKEN` |

Node.js is pinned to 24.12.0. Wrangler, Netlify and Vercel archives are checked against npm registry `dist.integrity` SHA-512 before installation. Native doctl, Railway and Supabase archives use SHA-256 digests from their versioned GitHub release asset metadata; Linux/macOS amd64/arm64 are explicitly supported. Unsupported platforms and mismatched digests fail before replacing an executable. Native downloads are bounded and temporary archives are removed on success or failure. Package dependencies continue using npm’s integrity verification, as with the existing Notion projection.

Public sources checked 2026-10-28 (no account credentials used):

- Cloudflare variables: https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- DigitalOcean env auth and default-context semantics: https://github.com/digitalocean/doctl/blob/v2.1.0/README.md#environment-variables
- Netlify token: https://docs.netlify.com/cli/get-started/#obtain-a-token-in-the-netlify-ui
- Railway token types: https://docs.railway.com/guides/cli#tokens
- Supabase token without login persistence: https://supabase.com/docs/reference/cli/introduction
- Vercel env token: https://vercel.com/docs/cli/global-options#token
- npm metadata: https://registry.npmjs.org/wrangler/4.154.0, https://registry.npmjs.org/netlify-cli/27.15.0, https://registry.npmjs.org/vercel/65.5.0
- Native releases: https://github.com/digitalocean/doctl/releases/tag/v2.1.0, https://github.com/railwayapp/cli/releases/tag/v5.71.0, https://github.com/supabase/cli/releases/tag/v2.122.0

## Staged rollout boundary

This change does not deploy itself or mutate live accounts, host variables or runtime skill configuration. Removal of all other exposure surfaces, fleet-wide removal of stale files, expanded credential detection and the broad agent-facing documentation rewrite are separate rollout stages. Existing exposure of unrelated custom values is not claimed removed by this provider migration.
