import { lazy, Suspense } from 'react'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import { Modal } from './Modal'
import { MonitorDetailsModal } from './monitors/MonitorDetailsModal'
import type { AgentConversation } from './AgentConversationBody'
import { ChatSkeleton } from './loading/Skeleton'

const LazyAgentConversation = lazy(() =>
  import('./AgentConversationBody').then((module) => ({ default: module.AgentConversation }))
)

export interface ToolInlineActionModalProps {
  action: ToolInlineAction
  onClose: () => void
  dependencies?: {
    AgentConversationComponent?: typeof AgentConversation
    MonitorDetailsModalComponent?: typeof MonitorDetailsModal
  }
}

export function ToolInlineActionModal({ action, onClose, dependencies }: ToolInlineActionModalProps) {
  if (action.kind === 'monitor') {
    const MonitorModal = dependencies?.MonitorDetailsModalComponent ?? MonitorDetailsModal
    return <MonitorModal monitorId={action.monitorId} onClose={onClose} />
  }
  const Conversation = dependencies?.AgentConversationComponent ?? LazyAgentConversation
  return (
    <Modal isOpen onClose={onClose} title={`${action.subagentLabel} chat`} size="viewport" noChildPadding>
      <Suspense fallback={<ChatSkeleton label="Loading conversation" />}>
        <Conversation agentId={action.subagentId} embedded enableFullscreen={false} />
      </Suspense>
    </Modal>
  )
}
