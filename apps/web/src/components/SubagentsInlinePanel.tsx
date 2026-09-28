import clsx from 'clsx'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Agent } from '@ficus/shared'
import { useWebSocket } from '../hooks/useWebSocket'
import { useURLStringState } from '../hooks/useURLState'
import { queries } from '../queryOptions'
import { getAgentConversationStatusRefetchInterval } from '../lib/agentConversationPolling'
import { getAgentName, getAgentPrimaryLabel } from '../lib/agentDisplay'
import { AgentConversation } from './AgentConversationBody'

function getSubagentSubtitle(agent: Agent): string {
  const pieces = [getAgentName(agent), agent.status, agent.id].filter(Boolean)
  return pieces.join(' · ')
}

interface SubagentsInlinePanelProps {
  parentAgentId: string
}

export function SubagentsInlinePanel({ parentAgentId }: SubagentsInlinePanelProps) {
  const [selectedId, setSelectedId] = useURLStringState<string>('subagent', '')
  const { isConnected: wsConnected } = useWebSocket()
  const { data: children = [] } = useQuery({
    ...queries.agents.children(parentAgentId),
    enabled: !!parentAgentId,
    refetchInterval: getAgentConversationStatusRefetchInterval({ wsConnected }),
  })

  const selected = children.find((child) => child.id === selectedId) ?? children[0]

  useEffect(() => {
    if (!children.length) {
      if (selectedId) setSelectedId('')
      return
    }
    if (!selectedId || !children.some((child) => child.id === selectedId)) {
      setSelectedId(children[0].id)
    }
  }, [children, selectedId, setSelectedId])

  if (!children.length) {
    return <div className="h-full p-4 text-sm text-muted">No subagents.</div>
  }

  return (
    <div className="h-full min-h-0 flex flex-col md:flex-row bg-surface">
      <aside className="shrink-0 md:w-72 border-b md:border-b-0 md:border-r border-th-border overflow-y-auto max-h-48 md:max-h-none p-2 space-y-1">
        {children.map((child) => {
          const active = child.id === selected?.id
          return (
            <button
              key={child.id}
              type="button"
              onClick={() => setSelectedId(child.id)}
              className={clsx(
                'ficus-button',
                'w-full text-left px-2 py-2 rounded-md transition-colors',
                active ? 'bg-surface-secondary text-primary' : 'text-secondary hover:bg-surface-hover'
              )}
              aria-current={active ? 'page' : undefined}
            >
              <div className="text-sm font-medium truncate">{getAgentPrimaryLabel(child)}</div>
              <div className="text-[11px] text-muted truncate">{getSubagentSubtitle(child)}</div>
            </button>
          )
        })}
      </aside>
      <main className="flex flex-col grow min-w-0 min-h-0 overflow-hidden">
        {selected ? (
          <AgentConversation key={selected.id} agentId={selected.id} embedded enableFullscreen={false} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted">Select a subagent.</div>
        )}
      </main>
    </div>
  )
}
