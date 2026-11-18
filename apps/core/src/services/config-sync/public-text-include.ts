import { eq } from 'drizzle-orm'
import { PUBLIC_TEXT_SHARED_PROMPT_ID } from '@ficus/shared'
import { agentTypes, db, sharedPrompts } from '../../db'
import { AgentType } from '../../entities/AgentType'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('config-sync')

const SQUAD_RULES_INCLUDE = 'squad-rules'
const LEGACY_PUBLIC_HEADING = '## Public communication'

/**
 * The include list a type needs once the "Public communication" section moved
 * out of `squad-rules` into `public-text`: `public-text` right after
 * `squad-rules`. Null when the list does not name `squad-rules` or already
 * names `public-text`.
 */
export function expandPublicTextInclude(includes: readonly string[]): string[] | null {
  if (includes.includes(PUBLIC_TEXT_SHARED_PROMPT_ID)) return null
  const at = includes.indexOf(SQUAD_RULES_INCLUDE)
  if (at < 0) return null
  const next = [...includes]
  next.splice(at + 1, 0, PUBLIC_TEXT_SHARED_PROMPT_ID)
  return next
}

/** Whether the `public-text` shared prompt is already stored, read before a shared-prompt sync. */
export async function publicTextIncludeStored(): Promise<boolean> {
  const rows = await db
    .select({ id: sharedPrompts.id })
    .from(sharedPrompts)
    .where(eq(sharedPrompts.id, PUBLIC_TEXT_SHARED_PROMPT_ID))
  return rows.length > 0
}

/**
 * One-time migration, run by the shared-prompt sync that first inserts
 * `public-text`. Built-in types that follow their template get the new list
 * from YAML in the agent-type sync that follows. A custom type, or a built-in
 * type whose include list an admin overrode, still names only `squad-rules`
 * and would lose the fixed public-text rules; add `public-text` after it. It
 * does not run again, so a later admin edit to an include list is respected.
 */
export async function adoptPublicTextInclude(): Promise<void> {
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
    const followsTemplate = row.template != null && !((row.overrides as string[] | null) ?? []).includes('includes')
    if (followsTemplate) continue
    const next = expandPublicTextInclude(row.includes ?? [])
    if (!next) continue
    await db.update(agentTypes).set({ includes: next, updatedAt: new Date() }).where(eq(agentTypes.id, row.id))
    log.info(`agent type '${row.id}': added the '${PUBLIC_TEXT_SHARED_PROMPT_ID}' include after '${SQUAD_RULES_INCLUDE}'`)
    changed = true
  }
  if (changed) AgentType.invalidateCache()

  // An overridden squad-rules keeps the admin's text, which may still carry the
  // old section: say so rather than rewrite it.
  const [squadRules] = await db
    .select({ content: sharedPrompts.content, overrides: sharedPrompts.yamlFieldOverrides })
    .from(sharedPrompts)
    .where(eq(sharedPrompts.id, SQUAD_RULES_INCLUDE))
  if (
    squadRules &&
    ((squadRules.overrides as string[] | null) ?? []).includes('content') &&
    squadRules.content.includes(LEGACY_PUBLIC_HEADING)
  ) {
    log.warn(
      `shared prompt '${SQUAD_RULES_INCLUDE}' is overridden and still contains "${LEGACY_PUBLIC_HEADING}", which is now the '${PUBLIC_TEXT_SHARED_PROMPT_ID}' include plus the squad's voice. Remove that section from the override, or revert it to the template, so agents do not read both.`
    )
  }
}
