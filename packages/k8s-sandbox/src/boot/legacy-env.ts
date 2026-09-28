/**
 * One-release in-process fallback for the Tau → Ficus env rename (side-effect module).
 *
 * Imported FIRST by the sandbox executor (`server.ts`): later imports read
 * `process.env` at module load. Names only, never values. Wave 3 (Task 36)
 * replaces the bridge with `stripLegacyEnv`.
 */
import { bridgeLegacyEnv, formatLegacyEnvBridge } from '@ficus/shared/legacy-env'

const lines = formatLegacyEnvBridge(bridgeLegacyEnv(process.env))

if (lines.warn) console.warn(`[sandbox] ${lines.warn}`)
if (lines.error) console.error(`[sandbox] ${lines.error}`)
