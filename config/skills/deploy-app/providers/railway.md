# Railway

Read `deploy-app` first; this note holds only what differs for Railway.

- **Fits:** APIs, long-running Node services, Dockerfile or custom runtimes, and
  Railway-managed databases. Always-on services and egress bill; say so before
  asking for approval, and put cleanup notes in the handoff.
- **Account:** sign up at https://railway.com/login. Token: https://railway.com/account/tokens.
  In the workspace selector choose **No workspace**, so the token is
  **Account**-scoped. Project tokens (`RAILWAY_TOKEN`) cannot create, list or link
  projects; Ficus needs the account token (`RAILWAY_API_TOKEN`). Settings card:
  **Settings → Integrations → Railway**.
- **CLI:** `railway`. Check access with `railway list`. If authentication fails,
  have the human validate or reconnect the account; do not restart the sandbox to
  pick up a token.
  Wrap project scripts: `ficus integration exec railway -- npm run deploy`.
- **Upload:** `railway up` uploads the current directory. Run it from the app's own
  directory, and add a `.railwayignore` before the first upload as a fallback.
- **Names:** keep project and service names short, lowercase, with hyphens; Railway
  rejects long names.

```bash
railway whoami
railway init -n <project-name> --json          # after consent
railway add --service <service-name> --json    # create the service before deploying to it
railway status
railway up --detach --message 'Deploy app'
railway deployment list --json
railway logs --build <deployment-id> --lines 300
railway logs --latest --lines 100
railway domain --service <service-name> --port <runtime-port> --json
```

- `railway up --service <name>` fails with `Service not found` until
  `railway add --service <name>` has created it.
- Railpack may detect npm for a Bun app and still run `npm run start`, which can
  call Bun successfully; check the build log before changing the setup.
- Public domains, paid plugins and database migrations need approval. Roll back by
  redeploying a known-good commit or with deployment controls; remove services and
  projects only after approval.
- Docs: https://docs.railway.com/guides/cli
