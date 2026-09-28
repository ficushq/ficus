import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { Modal } from '../Modal'
import { AgentViewTabs } from '../AgentViewTabs'
import { AgentConversation, SubagentsInlinePanel } from '../AgentConversation'
import { AgentInboxPanel } from './AgentInboxPanel'
import { AgentWorkStreamsPanel } from './AgentWorkStreamsPanel'
import { AgentContextPanel } from './AgentContextPanel'
import { AgentInfoPanel } from '../AgentInfoPanel'
import { ChatIcon, InboxIcon, WorkStreamIcon, MemoryIcon } from '../icons'
import type { Agent } from '@ficus/shared'
import { getAgentName, getAgentPurpose } from '../../lib/agentDisplay'

export function getAgentHeaderTitleParts(agent: Agent): { title: string; suffix: string } {
  const stableName = getAgentName(agent)
  if (agent.agentTypeId === 'manager') return { title: 'Manager', suffix: `(${stableName})` }
  const purpose = getAgentPurpose(agent)
  const type = agent.agentTypeId
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
  return { title: purpose ?? type, suffix: purpose ? `(${type} • ${stableName})` : `(${stableName})` }
}

/** Keep the full desktop title and a compact two-line identity on phones. */
export function AgentHeaderTitle({ agent }: { agent: Agent }) {
  const { title, suffix } = getAgentHeaderTitleParts(agent)
  return (
    <span className="block min-w-0">
      <span className="hidden md:block truncate">
        {title} <span className="font-normal text-secondary">{suffix}</span>
      </span>
      <span className="block md:hidden">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-xs font-normal text-secondary">{suffix.slice(1, -1)}</span>
      </span>
    </span>
  )
}

type AgentViewTab = 'chat' | 'work' | 'inbox' | 'subagents' | 'context' | 'info'

export interface AgentViewModalDependencies {
  AgentConversationComponent?: typeof AgentConversation
}

export interface AgentViewModalProps {
  agent: Agent
  squadId: string
  onClose: () => void
  initialTab?: AgentViewTab
  focusMessageId?: string
  /** Inbox message id: focuses the transcript message that delivered it. */
  focusInboxMessageId?: string
  /** Per-instance UI dependencies for isolated rendering (test seam). */
  dependencies?: AgentViewModalDependencies
}

/**
 * Full-screen agent view: the same tabbed chat/work/inbox/subagents/context/info
 * modal used by the squad agent panel's fullscreen path (SquadAgentThreads),
 * extracted so other surfaces (e.g. the Activity tab) can open an agent in the
 * same shape.
 */
export function AgentViewModal({
  agent,
  squadId,
  onClose,
  initialTab,
  focusMessageId,
  focusInboxMessageId,
  dependencies,
}: AgentViewModalProps) {
  const AgentConversationComponent = dependencies?.AgentConversationComponent ?? AgentConversation
  const [activeTab, setActiveTab] = useState<AgentViewTab>(initialTab ?? 'chat')

  const { data: agentType } = useQuery({
    ...queries.agentTypes.detail(agent.agentTypeId),
    enabled: !!agent.agentTypeId,
  })
  const { data: subagents = [] } = useQuery({
    ...queries.agents.children(agent.id),
    enabled: !!agent.id,
  })
  const hasSubagents = subagents.length > 0
  const activeSubagentCount = subagents.filter((child) => child.status === 'active').length
  const effectiveTab = activeTab === 'subagents' && !hasSubagents ? 'chat' : activeTab

  const { title, suffix } = getAgentHeaderTitleParts(agent)

  const tabToggle = (
    <AgentViewTabs
      activeTab={effectiveTab}
      onChange={setActiveTab}
      tabs={[
        { value: 'chat', label: 'Chat', icon: ChatIcon },
        { value: 'work', label: 'Work', icon: WorkStreamIcon },
        { value: 'inbox', label: 'Inbox', icon: InboxIcon },
        ...(hasSubagents
          ? ([
              {
                value: 'subagents',
                label: 'Subagents',
                icon: ChatIcon,
                secondary: true,
                activeCount: activeSubagentCount,
              },
            ] as const)
          : []),
        { value: 'context', label: 'Context', icon: MemoryIcon },
        { value: 'info', label: 'Info', icon: MemoryIcon },
      ]}
    />
  )

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${title} ${suffix}`}
      titleContent={<AgentHeaderTitle agent={agent} />}
      mobileFullscreen
      headerExtra={tabToggle}
      maxWidth="chat"
      noChildPadding
    >
      <div className="flex flex-col grow min-h-0">
        {effectiveTab === 'work' ? (
          <AgentWorkStreamsPanel agent={agent} squadId={squadId} />
        ) : effectiveTab === 'inbox' ? (
          <AgentInboxPanel agent={agent} onClose={() => setActiveTab('chat')} fullWidth />
        ) : effectiveTab === 'context' ? (
          <AgentContextPanel agentId={agent.id} />
        ) : effectiveTab === 'subagents' ? (
          <SubagentsInlinePanel parentAgentId={agent.id} />
        ) : effectiveTab === 'info' ? (
          <AgentInfoPanel agent={agent} agentType={agentType} />
        ) : (
          <AgentConversationComponent
            key={agent.id}
            agentId={agent.id}
            enableFullscreen={false}
            focusMessageId={focusMessageId}
            focusInboxMessageId={focusInboxMessageId}
          />
        )}
      </div>
    </Modal>
  )
}
