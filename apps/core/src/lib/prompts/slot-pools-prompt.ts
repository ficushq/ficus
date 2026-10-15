import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, slotPools, squads } from '../../db'
import { formatSlotClaimTimeout } from '../../services/slots/format'
import { createLogger } from '../infra/logger'

const log = createLogger('slot-pools-prompt')

/** Template token for the generated section, placed right after `{{squad.context}}`. */
export const SLOT_POOLS_PROMPT_TOKEN = '{{squad.slotPools}}'

export interface SlotPoolPromptEntry {
  key: string
  capacity: number
  claimTimeoutMs: number
  usage: string | null
}

/**
 * Render the squad's enforced slot pools for agent prompts. Rendered at prompt
 * assembly from the live pool registry, never stored in squad context, so
 * guidance changes reach every agent on its next turn. Live usage (holders,
 * queue) is deliberately omitted: it changes constantly and `ficus slot list`
 * reports it authoritatively. Returns '' when there are no pools.
 */
export function renderSlotPoolsPrompt(pools: readonly SlotPoolPromptEntry[]): string {
  if (pools.length === 0) return ''
  const lines = [
    '## Slot Pools',
    '',
    'Registered capacity pools in this squad. Claim a pool before the work its guidance names (see Slot Coordination) and release it when done. Run `ficus slot list` for live holders and queue.',
    '',
  ]
  for (const pool of pools) {
    lines.push(
      `- \`${pool.key}\`: capacity ${pool.capacity}, claim timeout ${formatSlotClaimTimeout(pool.claimTimeoutMs)}`
    )
    const usage = pool.usage?.trim()
    if (usage) {
      for (const line of usage.split(/\r?\n/)) lines.push(line.trim() ? `  ${line.trimEnd()}` : '')
    }
  }
  return lines.join('\n')
}

/**
 * The section to place directly when a composed agent-type prompt does not
 * carry {@link SLOT_POOLS_PROMPT_TOKEN} (custom types, or a drifted
 * squad-rules include), so every squad agent still sees its pools exactly once.
 */
export function slotPoolsPromptFallback(typePrompt: string, section: string): string {
  return section && !typePrompt.includes(SLOT_POOLS_PROMPT_TOKEN) ? section : ''
}

/**
 * Active (registered, enabled) pools of a live squad, ordered by key. Disabled
 * pools are not enforced, so agents must not be told to claim them.
 */
export async function loadSlotPoolPromptEntries(squadId: string): Promise<SlotPoolPromptEntry[]> {
  return db
    .select({
      key: slotPools.key,
      capacity: slotPools.capacity,
      claimTimeoutMs: slotPools.claimTimeoutMs,
      usage: slotPools.usage,
    })
    .from(slotPools)
    .innerJoin(squads, eq(squads.id, slotPools.squadId))
    .where(
      and(
        eq(slotPools.squadId, squadId),
        isNull(slotPools.unregisteredAt),
        isNull(slotPools.disabledAt),
        isNull(squads.archivedAt)
      )
    )
    .orderBy(asc(slotPools.key))
}

/**
 * The generated "Slot Pools" prompt section for a squad, or '' when it has no
 * active pools. A failed read degrades to no section rather than failing the
 * agent's session setup; the slot routes still enforce admission.
 */
export async function buildSlotPoolsPrompt(squadId: string): Promise<string> {
  try {
    return renderSlotPoolsPrompt(await loadSlotPoolPromptEntries(squadId))
  } catch (error) {
    log.warn('Slot pools prompt section unavailable', { squadId, error })
    return ''
  }
}
