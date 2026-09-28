import { useQuery } from '@tanstack/react-query'
import type { AssistantActivityPage } from '@ficus/shared'
import { assistantQueries } from '../queryOptions'
import { usePermissions } from './usePermissions'

export interface AssistantActivityState {
  /** Owner the cached activity belongs to; `null` while signed out or unresolved. */
  ownerId: string | null
  activity: AssistantActivityPage | undefined
  /** Conversations with unread updates — the nav badge. Executing tasks never count here. */
  unreadConversations: number
  isError: boolean
}

/**
 * Application-wide discovery of durable Assistant activity. Runs whenever the signed-in user holds
 * `chat:send`, independently of whether the Assistant panel is open, and never opens a mailbox
 * lease or a Realtime session. Data stays owner-keyed so another account on the same device never
 * sees cached previews; the auth lifecycle clears the cache on logout.
 */
export function useAssistantActivity(options: { offset?: number; enabled?: boolean } = {}): AssistantActivityState {
  const { can, identity } = usePermissions()
  const ownerId =
    identity?.type === 'user' ? identity.userId : identity?.type === 'agent' ? (identity.userId ?? null) : null
  const enabled = (options.enabled ?? true) && ownerId !== null && can('chat:send')
  const query = useQuery({ ...assistantQueries.activity(ownerId ?? '', options.offset ?? 0), enabled })
  return {
    ownerId,
    activity: enabled ? query.data : undefined,
    // A failed refresh keeps the last good count; only a signed-out or unauthorized state reads as zero.
    unreadConversations: enabled ? (query.data?.totals.unreadConversations ?? 0) : 0,
    isError: query.isError,
  }
}
