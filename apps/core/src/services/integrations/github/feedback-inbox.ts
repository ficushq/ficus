import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db, inbox } from '../../../db'
import { githubInboxCondition } from './feedback-pass-read'
import { githubOutputPass, reserveGitHubLookahead, withGitHubOutputPass } from './feedback-pass'

// One bounded seek cursor, not a map of all agents/history. Empty pages wrap without rescanning.
let ordinaryCursor: string | undefined
export async function selectGitHubInboxPage(agentId?: string) {
  const limit = reserveGitHubLookahead(25)
  if (!limit) return []
  const rows = await db
    .select({ id: inbox.id, recipientId: inbox.recipientId })
    .from(inbox)
    .where(
      and(
        eq(inbox.recipientType, 'agent'),
        isNull(inbox.readAt),
        isNull(inbox.deliveredAt),
        sql`${inbox.metadata}->>'source' = 'integration-notification'`,
        githubInboxCondition(),
        agentId ? eq(inbox.recipientId, agentId) : undefined,
        !agentId && ordinaryCursor ? gt(inbox.id, ordinaryCursor) : undefined
      )
    )
    .orderBy(asc(inbox.id))
    .limit(limit)
  if (!agentId) ordinaryCursor = rows.at(-1)?.id
  return rows
}

/** A root class shares the same WORK/body/provider budget as release/unmatched/flow delivery.
 * Later active-agent dispatch consumes only this selected cohort, never per-agent GitHub sweeps.
 */
export async function reconcileGitHubInboxNotifications() {
  return withGitHubOutputPass(async () => {
    const pass = githubOutputPass()!
    if (pass.ordinary) return
    pass.ordinary = new Map()
    for (const row of await selectGitHubInboxPage()) {
      const ids = pass.ordinary.get(row.recipientId) ?? []
      ids.push(row.id)
      pass.ordinary.set(row.recipientId, ids)
    }
    const { deliverInboxMessagesToAgent } = await import('../../inbox/inboxDelivery')
    for (const agentId of [...pass.ordinary.keys()]) {
      try {
        await deliverInboxMessagesToAgent(agentId)
      } catch {
        // Dead/stale recipients remain durable. Never create a replacement or abort other queues.
      }
    }
  })
}
