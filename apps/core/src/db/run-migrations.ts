import '../boot/legacy-env'
import { MONOREPO_ROOT } from '../lib/paths'
import { loadRootEnvForStandaloneScript, resolveRootEnvDatabaseUrl } from './load-root-env'
import { runGuardedMigration } from './run-migrations-guard'

// Capture invocation intent before the root environment can supply defaults.
const explicitDatabaseUrl = process.env.DATABASE_URL
const rootDatabaseUrl = resolveRootEnvDatabaseUrl(MONOREPO_ROOT)
loadRootEnvForStandaloneScript(MONOREPO_ROOT)

await runGuardedMigration(
  {
    explicitDatabaseUrl,
    resolvedDatabaseUrl: process.env.DATABASE_URL,
    rootDatabaseUrl,
    liveEnvValue: process.env.FICUS_MIGRATE_LIVE,
    argv: process.argv,
  },
  // Keep connection and migrator modules behind the safety check so refusal
  // cannot import or execute database side effects. Top-level import rejection
  // propagates the canonical runner's exit status unchanged.
  () => import('./execute-migrations')
)
