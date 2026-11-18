# DigitalOcean

Read `deploy-app` first; this note holds only what differs for DigitalOcean.

- **Fits:** APIs and containers on App Platform, and managed databases. App Platform
  services, databases, droplets, load balancers and domains all bill.
- **Account:** sign up at https://cloud.digitalocean.com/registrations/new. Token:
  API → Tokens (https://cloud.digitalocean.com/account/api/tokens), with account read
  for validation and write for app creation and updates, and nothing broader.
  Settings card: **Settings → Integrations → DigitalOcean**.
- **CLI:** `doctl`. Check access with `doctl account get`.
  Wrap project scripts: `ficus integration exec digitalocean -- npm run deploy`.
- **Upload:** `.dockerignore` or the provider's ignore settings as a fallback;
  validate the App Platform spec from the app directory.

```bash
doctl apps list
doctl databases list
doctl apps spec validate .do/app.yaml
doctl apps list-deployments <app-id>
doctl apps logs <app-id>
```

- `doctl apps create`, `doctl apps update`, database creation, domains, scaling and
  any migration need approval.
- Roll back with App Platform deployment controls or by redeploying a known-good spec
  or commit. Destroy apps, databases or domains only after approval.
- Docs: https://docs.digitalocean.com/reference/doctl/
