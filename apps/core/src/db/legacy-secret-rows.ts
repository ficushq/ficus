import type postgres from 'postgres'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('db')

/**
 * The retained `TAU_` secret-store rows the Ficus rename copies to `FICUS_` (migration 0190).
 *
 * The `TAU_` rows stay for one release so a rolled-back Core still finds them.
 * Known cost: after a rollback the old Core reads its `TAU_` row, which misses
 * any rotation the new Core made to the `FICUS_` row in the meantime.
 */
export const COPIED_LEGACY_SECRET_ROW_KEYS = [
  'TAU_PASSWORD',
  'TAU_PUSH_RELAY_TOKEN',
  'TAU_PLATFORM_INSTANCE_TOKEN',
  'TAU_PLATFORM_USAGE_TOKEN',
] as const

/**
 * Runs immediately before migration 0190 copies the `TAU_` rows to `FICUS_`.
 *
 * The copy never overwrites an existing `FICUS_` row. When one already exists
 * and its stored ciphertext differs from the `TAU_` row's, the copy silently
 * keeps it, so name the pair here for the operator. Only key names are logged:
 * never a value, a ciphertext or an IV. A byte-identical pair is already in the
 * desired state and is not reported.
 */
export async function reportLegacySecretRowConflicts(
  connection: postgres.ReservedSql,
  warn: (message: string) => void = (message) => log.warn(message)
): Promise<string[]> {
  const rows = await connection.unsafe<{ legacy: string; current: string }[]>(
    `SELECT legacy.key AS legacy, current.key AS current
       FROM secrets legacy
       JOIN secrets current ON current.key = 'FICUS_' || substr(legacy.key, 5)
      WHERE legacy.key = ANY($1::text[])
        AND (current.encrypted_value, current.iv) IS DISTINCT FROM (legacy.encrypted_value, legacy.iv)
      ORDER BY legacy.key`,
    [[...COPIED_LEGACY_SECRET_ROW_KEYS]]
  )
  for (const { legacy, current } of rows) {
    warn(
      `Secret ${current} already exists and differs from ${legacy}; kept ${current} and did not copy ${legacy} over it. ` +
        `${legacy} stays for rollback only; check that ${current} holds the value you want.`
    )
  }
  return rows.map((row) => row.current)
}
