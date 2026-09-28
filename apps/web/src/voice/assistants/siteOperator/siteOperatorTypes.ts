import type { AssistantConversationBridge } from '../../AssistantConversationContext'
import type { Agent, Squad } from '@ficus/shared'
import type { WebSocketContextValue } from '../../../hooks/useWebSocket'
import type { InboxMessageResponse } from '../../../api/inbox'
import type { VisibleAgentContext } from '../../pageContext'

export interface SiteOperatorSessionContext {
  squads: (Pick<Squad, 'id' | 'name' | 'purpose' | 'status'> & {
    createdAt?: Squad['createdAt']
    agents: Pick<Agent, 'id' | 'agentTypeId' | 'status'>[]
  })[]
  currentPath?: string
  recentPaths?: string[]
  visibleAgents?: VisibleAgentContext[]
}

export interface SiteOperatorAssistantState {
  sessionContext: SiteOperatorSessionContext | null
  pathHistory: string[]
  inboxQueue: InboxMessageResponse[]
  activeInboxAnnouncement: InboxMessageResponse | null
  spokenInboxIds: Set<string>
  spokenWaitingInputAgentIds: Set<string>
}

export interface SiteOperatorEnvironment extends Partial<AssistantConversationBridge> {
  can?: (permission: string) => boolean
  currentPath: string
  navigate: (path: string) => void
  getCurrentPath: () => string
  subscribe: WebSocketContextValue['subscribe']
}
