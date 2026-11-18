import { formatSlotClaimTimeout } from '../../services/slots/format'

/*
 * The generated Slot Pools section, rendered from pool entries. No database access, so the agent
 * behaviour evals can render it from fixtures; slot-pools-prompt.ts loads the live entries.
 */

/** Template token for the generated section, placed right after `{{squad.context}}`. */
export const SLOT_POOLS_PROMPT_TOKEN = '{{squad.slotPools}}'

/**
 * How to claim, wait for, renew and release a slot. It lives in the generated
 * section, not a static include, so only agents in a squad with pools read it.
 */
export const SLOT_COORDINATION_GUIDANCE =
  'Before work a pool protects, claim it with `ficus slot claim <key>`. The pools above and their usage guidance say what each protects and when to claim it; squad context may also name a protected resource and its pool. A successful command exit does not mean a slot was granted; automation must inspect the returned `outcome` before starting protected work. A blocked claim queues you automatically and returns `queued` with a waiter id — that is not ownership, so end the turn and do not begin until the grant wake arrives. A pool listed as host-shared also draws on a budget shared with the other squads on your machine host, so you can be queued while your own pool has room; wait for the grant all the same. Renew only while the resource is still needed, and release immediately after protected work finishes, including failure cleanup. Shortly before a claim expires you get one warning notice: renew if you still need the resource, otherwise release it. Renew, release, and unsubscribe take only the claim or waiter id (`ficus slot release <claim-id>`), with no pool key or squad. Treat expiry or dormancy cleanup as authoritative loss of ownership. When a claim is released or expires, Ficus stops the background processes your commands started while holding it, unless you still hold another claim they were started under or you started them with `FICUS_KEEP_RUNNING=1`; it does not stop containers such as test databases, so stop those yourself before releasing. After interruption or uncertainty, recover authoritative state with `ficus slot list`. A `disabled` outcome (or a notice that a pool you were queued on was disabled) means the pool is not enforced right now: nothing was claimed or queued, the work is not slot-gated, so proceed under the remaining squad rules. Claim it again if it is re-enabled.'

export interface SlotPoolPromptEntry {
  key: string
  capacity: number
  claimTimeoutMs: number
  usage: string | null
  /**
   * Set only for a host-shared pool whose squad is on a machine with a slot
   * budget: how many such claims that machine allows across all squads.
   */
  hostCapacity?: number
  /** Set (with hostCapacity) when the pool has no cap of its own: only the host's budget limits it. */
  capacityFollowsHost?: true
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
    'Registered capacity pools in this squad. Claim a pool before the work its guidance names and release it when done. Run `ficus slot list` for live holders and queue.',
    '',
  ]
  for (const pool of pools) {
    const timeout = `claim timeout ${formatSlotClaimTimeout(pool.claimTimeoutMs)}`
    const hostAllows =
      pool.hostCapacity === undefined
        ? ''
        : `this machine host allows ${pool.hostCapacity} such claim${pool.hostCapacity === 1 ? '' : 's'} at once across all squads on it`
    lines.push(
      pool.hostCapacity === undefined
        ? `- \`${pool.key}\`: capacity ${pool.capacity}, ${timeout}`
        : pool.capacityFollowsHost
          ? `- \`${pool.key}\`: ${timeout}, host-shared with no cap of its own (${hostAllows})`
          : `- \`${pool.key}\`: capacity ${pool.capacity}, ${timeout}, host-shared (${hostAllows}, so you can be queued while this pool has room)`
    )
    const usage = pool.usage?.trim()
    if (usage) {
      for (const line of usage.split(/\r?\n/)) lines.push(line.trim() ? `  ${line.trimEnd()}` : '')
    }
  }
  lines.push('', '### Slot Coordination', '', SLOT_COORDINATION_GUIDANCE)
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
