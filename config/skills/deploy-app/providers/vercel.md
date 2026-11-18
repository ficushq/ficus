# Vercel

Read `deploy-app` first; this note holds only what differs for Vercel.

- **Fits:** Next.js, Vite and other SPAs, static frontends.
- **Account:** sign up at https://vercel.com/signup and pick the owning team (team
  projects can bill). Token: https://vercel.com/account/settings/tokens, scoped to
  that account or team. Settings card: **Settings → Integrations → Vercel**.
- **CLI:** `vercel`. Check access with `vercel whoami`.
- **Upload:** `.vercelignore` as a fallback; check the build output directory for
  static builds.

```bash
vercel link                       # after consent to create or use the project
vercel project ls
vercel deploy                     # preview first
vercel ls
vercel logs <deployment-url-or-id>
```

- Production `vercel deploy --prod` and domain changes need approval.
- Roll back with `vercel rollback <deployment-url>`; remove with
  `vercel remove <deployment-url-or-id>` only after approval.
- Docs: https://vercel.com/docs/cli
