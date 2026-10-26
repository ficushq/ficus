# Per-host transaction pooling (Core side)

Part A of the plan kept in the hosted-platform repo
(`docs/superpowers/plans/2026-10-26-transaction-pooling.md`; design in
`docs/superpowers/specs/2026-10-26-transaction-pooling-design.md`). This file
is the pointer so the Core work can be picked up from this repo.

## What Core adds

- `scripts/setup/setup-host.sh`: optional `phase_pooler` (external database
  mode, `database.pool.enabled: true`): PgBouncer on `127.0.0.1:6432` in
  transaction mode (`default_pool_size` 4, `reserve_pool_size` 2,
  `reserve_pool_timeout` 1, `server_idle_timeout` 60,
  `max_prepared_statements` 200, upstream TLS verify-full against the
  installed database CA, `max_client_conn` 100), a `ficus-pgbouncer` unit,
  and two env vars: `DATABASE_URL` (pooled) and `DATABASE_DIRECT_URL`
  (cluster), plus `DATABASE_POOL_MODE=transaction`. Migrations run over the
  direct DSN. Self-hosted installs without the flag are unchanged.
- `apps/core/src/db/connection.ts`: `getDirectConnectionString()`
  (`DATABASE_DIRECT_URL ?? DATABASE_URL`); `getPoolMax()` defaults to 10 when
  pooled, 4 otherwise.
- Every session-scoped connection uses the direct DSN under the existing
  `withDedicatedConnectionSlot` gate: `db/execute-migrations.ts`,
  `db/index.ts` (dedicated transactions), `services/memory/WriteService.ts`,
  `services/updates/run-lock.ts`,
  `services/integrations/authorization/connection-lease.ts`,
  `services/machines/cli-bundle.ts`, `services/sandbox/toolchain/state.ts`,
  `services/sandbox/vm/setup-state.ts`,
  `services/maintenance/process-liveness.ts`. Migrations, run-lock and
  cli-bundle are newly gated.
- `services/machines/usage-reporter.ts`: `pgbouncerWaitingClients`,
  `pgbouncerMaxWaitMs`, `pgbouncerActiveServers` from `SHOW POOLS`, pooled
  installs only.
- CI: a `pgbouncer` service in `docker-compose.test.yml`; a pooled-path test
  (prepared statements across backends, xact-scoped locks) and a
  pooler-restart resilience test.

Tasks A1–A7 with their tests are spelled out in the platform-repo plan.
