# Database

## Overview

Ficus uses **PostgreSQL** with the **pgvector** extension for vector similarity search. The ORM layer is [Drizzle ORM](https://orm.drizzle.team/), which provides type-safe schema definitions, query building, and migration management.

## Connection

All database connections are centralized in `apps/core/src/db/connection.ts`.

The API and worker each default to a four-connection query pool. Runtime operations
that need dedicated connections share a two-connection gate per process: transactions
that hold locks across pool work, memory writes, VM setup, toolchain reconciliation,
and integration authorization. They queue before opening a connection and release
the slot only after closing it. A fresh `max: 1` pool per request does not bound the
number of connections across concurrent requests.

The worker also owns one long-lived admission-liveness connection. The default runtime
budget is therefore 13 connections across API and worker, leaving three under the
hosted role limit of 16 for builds, updates, and operator work. Custom pool sizes,
extra API/worker processes, and rolling process overlap need a corresponding database
connection budget.

### `createPostgresConnection(url, options)`

Every postgres connection in the codebase goes through this function. It wraps the `postgres` (postgres.js) driver and automatically configures SSL for AWS RDS:

- **RDS detection** — if the connection string contains `rds.amazonaws.com`, SSL is enabled automatically.
- **CA bundle** — looks for the AWS RDS global CA bundle at `/usr/local/share/ca-certificates/aws-rds-global-bundle.crt`. If found, it's used for full certificate verification.
- **Fallback** — if the CA bundle isn't present, connects with `rejectUnauthorized: false` and logs a warning.
- **Non-RDS** — SSL is not configured (local/dev connections).

### `getConnectionString()`

Reads the `DATABASE_URL` environment variable. Throws if not set.

## Query errors

Drizzle wraps postgres-js failures in `DrizzleQueryError`. Its message, stack,
`query` and `params` include SQL and application data; do not expose them to
clients, logs or durable failure summaries. Use `publicErrorMessage` for existing
catch-to-response paths and the ContentSafety boundary for logging. Known domain
validation messages retain their existing behavior.

Use `getPostgresError` from `apps/core/src/db/errors.ts` instead of top-level
`error.code` to recognize SQLSTATEs (for example, `23505` unique conflicts).
It inspects a bounded, cycle-safe cause chain and returns only the code and
optional constraint name. `hasErrorCode` supports allowlisted transport codes.

The disposable test database is push-built, not migration-built. Kit can omit
indexes (including `uq_agent_scope` on both Kit 0.30.6 and 0.31.10). Tests of a
migration-defined uniqueness fence must establish that exact index explicitly;
a passing application-side duplicate precheck is not a database race regression.

## Schema

The schema is defined in `apps/core/src/db/schema.ts` using Drizzle's `pgTable` definitions.

### Enums

| Enum                        | Values                                                            |
| --------------------------- | ----------------------------------------------------------------- |
| `message_role`              | `human`, `assistant`                                              |
| `image_status`              | `pending`, `used`, `failed`                                       |
| `agent_status`              | `idle`, `active`, `waiting-input`, `compacting`, `resetting`      |
| `execution_status`          | `queued`, `running`, `stopping`, `stopped`, `completed`, `failed` |
| `squad_status`              | `active`, `paused`, `archived`                                    |
| `sandbox_status`            | `none`, `initializing`, `ready`, `failed`                         |
| `squad_relationship_type`   | `reports_to`, `collaborates`, `depends_on`                        |
| `work_stream_status`        | `queued`, `active`, `done`, `canceled`                            |
| `inbox_message_sender_type` | `system`, `agent`, `human`                                        |
| `inbox_recipient_type`      | `agent`, `human`                                                  |
| `schedule_scope_type`       | `squad`, `agent`                                                  |

### Tables

| Table                 | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `agent_types`         | Agent type definitions (model, system prompt, skills, extensions) |
| `agents`              | Agent instances tied to an agent type                             |
| `executions`          | Execution runs for agents                                         |
| `messages`            | Conversation messages within executions                           |
| `squads`              | Groups of agents working together                                 |
| `squad_presets`       | Squad preset definitions                                          |
| `work_streams`        | Tracked work items within squads                                  |
| `schedules`           | Scheduled triggers for agents or squads                           |
| `inbox`               | Inter-agent and human-agent messaging                             |
| `memory_documents`    | Source documents for agent memory                                 |
| `memory_chunks`       | Chunked embeddings with `vector` column for similarity search     |
| `memory_links`        | Links between memory documents                                    |
| `secrets`             | Encrypted secrets storage                                         |
| `channel_instances`   | Communication channel instances (Slack, etc.)                     |
| `notification_config` | Notification routing configuration                                |

## Migrations

### Generating migrations

Migrations are generated from schema diffs by drizzle-kit:

```bash
bun db:generate
```

This reads `apps/core/src/db/schema.ts`, compares it to the current migration state, and produces a new timestamped SQL migration file in `apps/core/drizzle/`.

> **Never write migration SQL files by hand.** Always use `bun db:generate`.

### Configuration

Migration config lives in `apps/core/drizzle.config.ts`:

- **Schema source:** `./src/db/schema.ts`
- **Output directory:** `./drizzle`
- **Dialect:** `postgresql`
- **Extension filters:** PostGIS tables (`spatial_ref_sys`, `geometry_columns`, `geography_columns`) are excluded from schema operations.

### Consolidated workflow rollout

`0169_workflow_integration_rollout.sql` consolidates the unreleased PR #1448 migrations formerly numbered 0169–0181. Its snapshot was regenerated from the schema; its SQL preserves the original generated statements in order, including temporary columns and renames needed by the data backfills. The runner flushes preceding SQL and runs each backfill immediately before its associated DDL, all within the same transaction.

The journal retains the former final migration timestamp, `1788986460108`. Databases on the preceding released schema apply the consolidated migration once. Databases that already applied all thirteen original migrations skip it without changing their ledger or replaying DDL. Partially migrated versions of that unreleased branch are not supported by this consolidation. Future migrations should be generated normally after this snapshot.

### Running migrations

Migrations run **automatically on API startup**. For manual control:

```bash
FICUS_MIGRATE_LIVE=1 bun db:migrate  # Deliberately migrate the root .env database
DATABASE_URL=postgres://... bun db:migrate  # Migrate an explicit test/scratch database
bun db:push                         # Push schema directly (dev only, no migration files)
```

The migration runner fails closed without an explicit non-root `DATABASE_URL` or the deliberate live-migration confirmation shown above.

New indexes on existing hot tables must use Drizzle's `.concurrently()` option. The generated migration must contain only that single `CREATE INDEX CONCURRENTLY` statement. Both startup migration and `bun db:migrate` apply this isolated shape outside a transaction while ordinary migrations remain transactional. Interrupted builds are recovered: invalid indexes are dropped concurrently and retried, while unexpected same-name indexes fail closed.

Always generate migration SQL with `bun db:generate`; never hand-edit generated SQL.

## pgvector

The `vector` extension is created in the initial migration (`0000_rapid_wendigo.sql`):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

It's used by the `memory_chunks` table to store embeddings for vector similarity search, enabling semantic retrieval across agent memory.

## Testing

Tests use an **isolated Postgres instance** running in Docker, completely separate from the dev/production database.

The test preload (`apps/core/src/test-setup.ts`) handles everything automatically:

1. **Port allocation** — finds a free port (never uses `5432` to avoid hitting a production database).
2. **Container management** — starts a uniquely-named Docker container per worktree (name derived from directory hash).
3. **Schema push** — runs `drizzle-kit push` against the test database before any tests execute.
4. **CI support** — if a `DATABASE_URL` pointing to a `ficus_test` database is already set (e.g., GitHub Actions service container), it uses that instead of spinning up Docker.
5. **No-Docker fallback** — for a direct local `bun test`, if the container cannot be started (Docker stopped or broken), the preload prints why and continues: database-free test files run normally, and every database use fails immediately with `Core test database unavailable (...)`. CI and the package runner (`bun run --filter core test`, which sets `FICUS_TEST_REQUIRE_DB=1`) still exit on an unavailable database.

Multiple worktrees can run tests in parallel — each gets its own isolated container and port.

```bash
bun test             # Run tests (auto-starts test DB if needed)
```

If tests hang on DB connection or schema push, reset the test database:

```bash
bun run test:db:down && bun test
```

Test-DB containers stay running between runs for reuse speed. They carry a
`dev.ficus.test-db.repo-root` label with their checkout path, and the preload
sweeps projects whose worktree has been deleted (throttled to once an hour,
`apps/core/src/test-db-sweep.ts`) — deleting a worktree no longer leaks a
forever-running postgres. Broader dev disk GC (registry blobs, dangling
images, build cache) lives in `bun run docker:gc`; see the README's
"Disk hygiene" section.

## Production

Production uses **AWS RDS PostgreSQL** with SSL. The connection string is provided via the `DATABASE_URL` environment variable. SSL certificate verification is handled automatically by the connection layer (see [Connection](#connection) above).
