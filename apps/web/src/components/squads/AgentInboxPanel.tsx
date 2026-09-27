import { useMemo } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { useAgentInboxInvalidation } from '../../hooks/useAgentInboxInvalidation'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'
import { MarkdownContent } from '../MarkdownContent'
import { CloseIcon } from '../icons'
import { isWorkspaceVoiceRecipient, type Agent, type InboxMessage, type InboxMessageSenderType } from '@ficus/shared'

interface Props {
  agent: Agent
  onClose: () => void
  /** When true, fills available width instead of fixed w-96 */
  fullWidth?: boolean
}

const senderTypeColors: Record<InboxMessageSenderType, string> = {
  system: 'bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-700 dark:text-status-neutral-300',
  agent: 'bg-status-progress-100 dark:bg-status-progress-900/50 text-status-progress-700 dark:text-status-progress-300',
  user: 'bg-status-human-wait-100 dark:bg-status-human-wait-900/50 text-status-human-wait-700 dark:text-status-human-wait-300',
  voice_assistant: 'bg-decoration-8-100 dark:bg-decoration-8-900/50 text-decoration-8-700 dark:text-decoration-8-300',
  remote: 'bg-decoration-11-100 dark:bg-decoration-11-900/50 text-decoration-11-700 dark:text-decoration-11-300',
}

export function AgentInboxPanel({ agent, onClose, fullWidth }: Props) {
  const agentName = agent.metadata?.name || agent.agentTypeId
  const agentIds = useMemo(() => [agent.id], [agent.id])
  useAgentInboxInvalidation(agentIds, { includeMessages: true })

  const {
    data: messages = [],
    isLoading,
    isSuccess,
  } = useQuery({
    ...queries.inbox.messages(agent.id, true), // fetch all, unread shown first
    refetchInterval: 60_000,
  })
  const messageSkeletonCount = useLoadingShapeCount(
    `agents:${agent.id}:inbox`,
    isSuccess ? messages.length : undefined,
    { fallbackCount: 4, maxCount: 10 }
  )

  return (
    <div className={clsx('bg-surface flex flex-col h-full', fullWidth ? 'w-full' : 'w-96 border-l border-th-border')}>
      {/* Header - hidden when fullWidth (parent provides header) */}
      {!fullWidth && (
        <div className="p-4 border-b border-th-border flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-primary">{agentName}'s Inbox</h3>
            <p className="text-xs text-muted mt-0.5">
              {agent.agentTypeId} · {agent.id.slice(0, 8)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ficus-button p-1 text-muted hover:text-primary hover:bg-surface-hover rounded"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4">
            <CollectionSkeleton label="Loading agent inbox" count={messageSkeletonCount} />
          </div>
        ) : messages.length === 0 ? (
          <p className="p-4 text-sm text-muted">No messages</p>
        ) : (
          <div className="divide-y divide-th-border">
            {messages.map((msg) => (
              <MessageItem key={msg.id} message={msg} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function formatBadgeLabel(message: InboxMessage): string {
  const senderMetadata = message.metadata?.sender as Record<string, string> | undefined
  const isWorkspaceVoiceSender = message.senderType === 'voice_assistant' && isWorkspaceVoiceRecipient(message.senderId)
  const name =
    message.senderAgent?.metadata?.name ||
    senderMetadata?.name ||
    (isWorkspaceVoiceSender ? 'Voice Workspace Agent' : '')
  const agentTypeName =
    senderMetadata?.agentTypeName ||
    senderMetadata?.agentTypeId ||
    (message.senderType === 'voice_assistant' ? 'voice_assistant' : '')
  const senderId = message.senderId
    ? `[${isWorkspaceVoiceSender ? message.senderId : message.senderId.slice(0, 8)}]`
    : ''
  return [name, agentTypeName ? `(${agentTypeName})` : '', senderId].filter(Boolean).join(' ') || message.senderType
}

function MessageItem({ message }: { message: InboxMessage }) {
  const isUnread = !message.readAt

  return (
    <div className={clsx('p-3', isUnread && 'bg-accent/5')}>
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'text-xs px-1.5 py-0.5 rounded font-medium',
            senderTypeColors[message.senderType] || senderTypeColors.system
          )}
        >
          {formatBadgeLabel(message)}
        </span>
        {isUnread && <span className="w-2 h-2 bg-accent rounded-full flex-shrink-0" />}
      </div>
      <p className="text-xs text-muted mt-1">{new Date(message.createdAt).toLocaleString()}</p>
      {message.subject && <p className="font-medium text-sm text-primary mt-1">{message.subject}</p>}
      <div className="mt-2 bg-surface-secondary rounded p-2 border border-th-border max-h-64 overflow-y-auto">
        <MarkdownContent className="prose-xs">{message.content}</MarkdownContent>
      </div>
    </div>
  )
}
