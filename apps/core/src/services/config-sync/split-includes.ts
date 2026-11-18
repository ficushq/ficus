import { eq, inArray } from 'drizzle-orm'
import { agentTypes, db, sharedPrompts } from '../../db'
import { AgentType } from '../../entities/AgentType'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('config-sync')

/**
 * The include split out of `rules` and `squad-rules`. Its first insertion marks
 * the one sync on which pre-split include lists are migrated.
 */
export const READABLE_TEXT_INCLUDE = 'readable-text'
const RECOVERY_WAITS_INCLUDE = 'recovery-waits'
const READABLE_TEXT_HEADING = '### Readable text fields'

/**
 * The include list a pre-split type needs to keep the text that moved out of
 * `rules` and `squad-rules`, or null when it already has it or never had it.
 * `readable-text` goes before the first of the two old ids, `recovery-waits`
 * right after `rules` (it was part of `rules`; `squad-rules` never carried it).
 */
export function expandSplitIncludes(includes: readonly string[]): string[] | null {
  if (includes.includes(READABLE_TEXT_INCLUDE)) return null
  const rulesAt = includes.indexOf('rules')
  const squadRulesAt = includes.indexOf('squad-rules')
  if (rulesAt < 0 && squadRulesAt < 0) return null
  const next = [...includes]
  if (rulesAt >= 0 && !next.includes(RECOVERY_WAITS_INCLUDE)) next.splice(rulesAt + 1, 0, RECOVERY_WAITS_INCLUDE)
  next.splice(Math.min(...[rulesAt, squadRulesAt].filter((at) => at >= 0)), 0, READABLE_TEXT_INCLUDE)
  return next
}

/** Whether the `readable-text` shared prompt is already stored, read before a shared-prompt sync. */
export async function readableTextIncludeStored(): Promise<boolean> {
  const rows = await db
    .select({ id: sharedPrompts.id })
    .from(sharedPrompts)
    .where(eq(sharedPrompts.id, READABLE_TEXT_INCLUDE))
  return rows.length > 0
}

/**
 * One-time migration, run by the shared-prompt sync that first inserts
 * `readable-text`. Built-in types get their new include lists from YAML in the
 * agent-type sync that follows; a custom type, or a built-in type whose
 * include list an admin overrode, still names only `rules`/`squad-rules` and
 * would silently lose the text that moved into `readable-text` and
 * `recovery-waits`. Give such lists the split-out includes in place, so their
 * composed prompts keep the same rules. It does not run again, so a later
 * admin edit to an include list is respected like any other override.
 *
 * Slot coordination moved to the generated Slot Pools section, which every
 * squad agent already receives when pools exist, so it needs no migration.
 */
export async function adoptSplitIncludes(): Promise<void> {
  const rows = await db
    .select({
      id: agentTypes.id,
      includes: agentTypes.includes,
      template: agentTypes.yamlTemplate,
      overrides: agentTypes.yamlFieldOverrides,
    })
    .from(agentTypes)
  let changed = false
  for (const row of rows) {
    // A built-in row that follows its template takes the new YAML list in the
    // agent-type sync that runs next; expanding it here would only be overwritten,
    // and must not be, or the capability split would never reach that type.
    const followsTemplate = row.template != null && !((row.overrides as string[] | null) ?? []).includes('includes')
    if (followsTemplate) continue
    const next = expandSplitIncludes(row.includes ?? [])
    if (!next) continue
    await db.update(agentTypes).set({ includes: next, updatedAt: new Date() }).where(eq(agentTypes.id, row.id))
    log.info(`agent type '${row.id}': added includes split out of rules/squad-rules: ${next.join(', ')}`)
    changed = true
  }
  if (changed) AgentType.invalidateCache()

  // An overridden rules or squad-rules keeps the admin's text, which may still
  // carry the readable-text paragraph: say so rather than rewrite it.
  const overridden = await db
    .select({ id: sharedPrompts.id, content: sharedPrompts.content, overrides: sharedPrompts.yamlFieldOverrides })
    .from(sharedPrompts)
    .where(inArray(sharedPrompts.id, ['rules', 'squad-rules']))
  for (const prompt of overridden) {
    if (!((prompt.overrides as string[] | null) ?? []).includes('content')) continue
    if (!prompt.content.includes(READABLE_TEXT_HEADING)) continue
    log.warn(
      `shared prompt '${prompt.id}' is overridden and still contains "${READABLE_TEXT_HEADING}", which now has its own '${READABLE_TEXT_INCLUDE}' include. Remove that section from the override, or revert it to the template, so agents do not read it twice.`
    )
  }
}
