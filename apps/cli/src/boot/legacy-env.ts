/**
 * One-release in-process fallback for the Tau → Ficus env rename (side-effect module).
 *
 * Imported FIRST by the CLI entrypoint (and `scripts/pm2-name.ts`): later imports
 * read `process.env` at module load. Warns on stderr only when something moved,
 * so the normal case stays silent, and reports a conflict by name. Never prints
 * values. Wave 3 (Task 36) replaces the bridge with `stripLegacyEnv`.
 */
import { bridgeLegacyEnv, formatLegacyEnvBridge } from '@ficus/shared/legacy-env'

const lines = formatLegacyEnvBridge(bridgeLegacyEnv(process.env))

if (lines.warn) process.stderr.write(`${lines.warn}\n`)
if (lines.error) process.stderr.write(`${lines.error}\n`)
