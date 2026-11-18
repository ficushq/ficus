# Cloudflare Pages and Workers

Read `deploy-app` first; this note holds only what differs for Cloudflare.

- **Fits:** static and SPA output on Pages, edge code on Workers, anything with
  `wrangler.toml` or `wrangler.json`. Check Workers runtime compatibility first.
- **Account:** sign up at https://dash.cloudflare.com/sign-up. Token: My Profile →
  API Tokens → Create Token (https://dash.cloudflare.com/profile/api-tokens), a
  custom token with only what is needed:
  - Pages: Account → Cloudflare Pages: Edit, and Account → Account Settings: Read.
  - Workers: Account → Workers Scripts: Edit, and Account → Account Settings: Read.
  - Zone permissions only when routes, domains or DNS are approved.

  Settings card: **Settings → Integrations → Cloudflare**. Set the optional,
  nonsecret account ID on the connection when needed; it is passed to each command.

- **CLI:** `wrangler`. Check access with `wrangler whoami`.
- **Billing to ask about:** routes, custom domains, KV, R2, D1 and Workers usage.

```bash
wrangler pages project list
wrangler pages deploy dist --project-name <name> --branch preview   # Pages preview
wrangler deploy --dry-run                                           # Workers check
wrangler tail <worker-name>
```

- Production branch deploys, custom domains or routes, and resource bindings need
  approval.
- Roll back with Pages deployments or Workers versions and deployments. Delete
  projects, Workers, routes or data only after approval.
- Docs: https://developers.cloudflare.com/workers/wrangler/commands/
