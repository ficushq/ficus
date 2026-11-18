# Netlify

Read `deploy-app` first; this note holds only what differs for Netlify.

- **Fits:** static sites, Vite/React SPAs, Astro and other Jamstack apps that want
  Netlify forms or functions.
- **Account:** sign up at https://app.netlify.com/signup and pick the owning team
  (add-ons can bill). Token: User Settings → Applications → Personal access tokens
  (https://app.netlify.com/user/applications#personal-access-tokens). Settings card:
  **Settings → Integrations → Netlify**.
- **CLI:** `netlify`. Check access with `netlify sites:list`.
  Wrap project scripts: `ficus integration exec netlify -- npm run deploy`.
- **Upload:** deploy the explicit build output with `--dir`; `.netlifyignore` as a
  fallback.

```bash
netlify link                      # after consent
netlify deploy --dir dist         # draft deploy first; use the real build output
netlify status
netlify deploy:list
```

- `netlify deploy --prod`, domain changes, and forms or functions that bill need
  approval.
- Roll back from the site's deploy history in the Netlify UI and verify the
  restored deploy. Delete sites only after approval.
- Docs: https://cli.netlify.com/
