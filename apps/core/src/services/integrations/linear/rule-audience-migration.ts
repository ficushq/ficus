import { eq, sql } from 'drizzle-orm'
import { db, squads } from '../../../db'
import { getSettingsStore, type SettingsStore } from '../../settings/store'

export const LINEAR_RULE_AUDIENCES_MIGRATED_SETTING_KEY = 'LINEAR_RULE_AUDIENCES_MIGRATED'

/** Assignment rules were already bound to the connected account by ingress, so their audience keeps its meaning. */
const ACCOUNT_BOUND_OUTPUTS = new Set(['issue.assigned', 'issue.unassigned'])

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
}

/**
 * Before agent app support, Linear ignored a rule's account involvement, although the rules editor
 * saved one on every rule. Stored rules keep their old behavior by becoming `any`, except the
 * assignment rules ingress already bound. Returns null when nothing changes.
 */
export function legacyLinearRulesKeepingBehavior(rules: unknown): unknown[] | null {
  if (!Array.isArray(rules)) return null
  let changed = false
  const next = rules.map((rule) => {
    const item = record(rule)
    const filters = record(item?.filters)
    const output = record(item?.source)?.output
    if (!item || !filters || filters.audience === 'any' || ACCOUNT_BOUND_OUTPUTS.has(output)) return rule
    changed = true
    return { ...item, filters: { ...filters, audience: 'any' } }
  })
  return changed ? next : null
}

/**
 * One-time upgrade step, run at startup by both the api and the worker process (whichever starts
 * first), before either routes a Linear event under the new audience semantics. Each squad is
 * rewritten under its row lock and only non-`any` audiences change, so running it from both
 * processes is safe. Rules saved afterwards keep the audience they are saved with.
 */
export async function migrateLinearRuleAudiences(store: SettingsStore = getSettingsStore()): Promise<number> {
  if (store.getStoredValue(LINEAR_RULE_AUDIENCES_MIGRATED_SETTING_KEY)) return 0
  const candidates = await db
    .select({ id: squads.id })
    .from(squads)
    .where(sql`jsonb_typeof(${squads.metadata}->'integrationRules'->'linear') = 'array'`)
  let migrated = 0
  for (const { id } of candidates) {
    const changed = await db.transaction(async (tx) => {
      const [squad] = await tx.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, id)).for('update')
      const metadata = record(squad?.metadata)
      const rules = legacyLinearRulesKeepingBehavior(record(metadata?.integrationRules)?.linear)
      if (!metadata || !rules) return false
      await tx
        .update(squads)
        .set({ metadata: { ...metadata, integrationRules: { ...metadata.integrationRules, linear: rules } } })
        .where(eq(squads.id, id))
      return true
    })
    if (changed) migrated++
  }
  await store.set(LINEAR_RULE_AUDIENCES_MIGRATED_SETTING_KEY, new Date().toISOString(), 'system')
  return migrated
}
