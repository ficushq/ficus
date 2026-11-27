import { useMemo, useState } from 'react'
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
import { getAgentLabel, getAgentName, noAgentTypeNames, type AgentTypeName } from '../../lib/agentDisplay'
import { useAgentTypeNames } from '../../hooks/useAgentTypeNames'

const titleCase = (id: string) =>
  id
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

/** A workflow agent is named `<participant> · <stream title>`: show the participant id title-cased. */
function displayName(name: string): string {
  const match = /^([a-z0-9]+(?:[-_][a-z0-9]+)*) · (.+)$/.exec(name)
  return match ? `${titleCase(match[1]!)} · ${match[2]}` : name
}

/**
 * The agent chat header: the agent's type first, with its purpose in parentheses ("Engineer
 * (Onboarding)"), then its name as the secondary handle. A squad has one manager, so it is
 * "Manager". A workflow agent's name leads with its participant, title-cased.
 */
export function getAgentHeaderTitleParts(
  agent: Agent,
  typeNames: AgentTypeName = noAgentTypeNames
): { title: string; suffix: string } {
  const stableName = displayName(getAgentName(agent))
  if (agent.agentTypeId === 'manager') return { title: 'Manager', suffix: stableName }
  return { title: getAgentLabel(agent, undefined, typeNames), suffix: stableName }
}

/** Keep the full desktop title and a compact two-line identity on phones. */
export function AgentHeaderTitle({ agent }: { agent: Agent }) {
  const { title, suffix } = getAgentHeaderTitleParts(agent, useAgentTypeNames())
  return (
    <span className="block min-w-0">
      <span className="hidden md:block truncate">
        {title} <span className="font-normal text-secondary">· {suffix}</span>
      </span>
      <span className="block md:hidden">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-xs font-normal text-secondary">{suffix}</span>
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
  const sharedTypeNames = useAgentTypeNames()
  // This agent's own type is loaded here anyway, so its name shows even without the shared list.
  const typeNames = useMemo<AgentTypeName>(
    () => (id) => sharedTypeNames(id) ?? (id === agentType?.id ? agentType.name : undefined),
    [sharedTypeNames, agentType]
  )

  const { title, suffix } = getAgentHeaderTitleParts(agent, typeNames)

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
