import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, integrationAuthorizationFlowReceipts, integrationOauthStates } from '../../../db'
import { BROKER_COMPLETION_HANDLE_PATTERN } from './service'

export type AuthorizationFlowSource = { kind: 'callback'; state: string } | { kind: 'complete'; localFlowId: string }

/**
 * The provider that started an OAuth flow, read from the caller's own server-side flow state.
 *
 * Every hosted broker flow except GitHub's, and every self-hosted flow without a provider path
 * suffix, returns to one shared callback page. The browser cannot reliably know which provider
 * started the flow: a flow started in the Desktop app or another tab returns in a browser tab that
 * never saw the start. The stored state is bound to the person who started it, so this reveals
 * nothing about anyone else's flows. A completed hosted flow keeps its receipt, so a reload after a
 * success or a terminal failure still resolves.
 */
export async function resolveAuthorizationFlowProvider(input: {
  userId: string
  source: AuthorizationFlowSource
}): Promise<string | null> {
  const { source } = input
  if (source.kind === 'callback') {
    if (!BROKER_COMPLETION_HANDLE_PATTERN.test(source.state)) return null
    const stateHash = createHash('sha256').update(source.state).digest('hex')
    const [state] = await db
      .select({ providerKey: integrationOauthStates.providerKey })
      .from(integrationOauthStates)
      .where(
        and(
          eq(integrationOauthStates.userId, input.userId),
          eq(integrationOauthStates.authority, 'local'),
          eq(integrationOauthStates.stateHash, stateHash)
        )
      )
      .limit(1)
    return state?.providerKey ?? null
  }
  if (!z.uuid().safeParse(source.localFlowId).success) return null
  const [state] = await db
    .select({ providerKey: integrationOauthStates.providerKey })
    .from(integrationOauthStates)
    .where(
      and(
        eq(integrationOauthStates.userId, input.userId),
        eq(integrationOauthStates.authority, 'platform_broker'),
        eq(integrationOauthStates.localFlowId, source.localFlowId)
      )
    )
    .limit(1)
  if (state) return state.providerKey
  const [receipt] = await db
    .select({ providerKey: integrationAuthorizationFlowReceipts.providerKey })
    .from(integrationAuthorizationFlowReceipts)
    .where(
      and(
        eq(integrationAuthorizationFlowReceipts.initiatingUserId, input.userId),
        eq(integrationAuthorizationFlowReceipts.authority, 'platform_broker'),
        eq(integrationAuthorizationFlowReceipts.localFlowId, source.localFlowId)
      )
    )
    .limit(1)
  return receipt?.providerKey ?? null
}
