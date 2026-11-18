# Supabase

Read `deploy-app` first; this note holds only what differs for Supabase. Supabase is
usually a companion service (Postgres, auth, storage, realtime, Edge Functions),
not the web host.

- **Account:** sign up at https://supabase.com/dashboard/sign-up and pick the owning
  organization (database size, storage, egress and functions bill). Token:
  Account → Access Tokens (https://supabase.com/dashboard/account/tokens). Settings
  card: **Settings → Integrations → Supabase**.
- **CLI:** `supabase`. Check access with `supabase projects list`.
- Run from the directory that holds `supabase/config.toml` and the migrations, and
  confirm the linked project before anything non-local.

```bash
supabase status || true
supabase db diff || true
supabase link --project-ref <ref>     # after consent
supabase migration list
supabase functions list
```

- `supabase db push`, `supabase functions deploy`, and auth policy or storage bucket
  changes need approval. Never run a non-local migration without it.
- Roll back with reviewed reverse migrations or backups, or redeploy the previous
  function version. Delete projects, buckets or functions only after approval.
- Docs: https://supabase.com/docs/reference/cli/introduction
