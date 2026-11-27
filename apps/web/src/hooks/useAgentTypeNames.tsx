import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { noAgentTypeNames, type AgentTypeName } from '../lib/agentDisplay'

const AgentTypeNamesContext = createContext<AgentTypeName>(noAgentTypeNames)

/** Agent type names change rarely; settings edits invalidate the list themselves. */
const AGENT_TYPE_NAMES_STALE_MS = 5 * 60_000

/**
 * Loads the squad's agent types once for the signed-in app, so every label names an agent by its
 * configured type name (`AgentType.name`). Without the list (still loading, offline, or no
 * permission to read agent types) labels fall back to the title-cased type id.
 */
export function AgentTypeNamesProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({ ...queries.agentTypes.list(), retry: false, staleTime: AGENT_TYPE_NAMES_STALE_MS })
  const typeNames = useMemo(() => agentTypeNamesFrom(data ?? []), [data])
  return <AgentTypeNamesContext.Provider value={typeNames}>{children}</AgentTypeNamesContext.Provider>
}

/** Fixed names, for tests and previews that render without the signed-in app around them. */
export function StaticAgentTypeNames({ names, children }: { names: Record<string, string>; children: ReactNode }) {
  const typeNames = useMemo(
    () => agentTypeNamesFrom(Object.entries(names).map(([id, name]) => ({ id, name }))),
    [names]
  )
  return <AgentTypeNamesContext.Provider value={typeNames}>{children}</AgentTypeNamesContext.Provider>
}

/** The configured name for an agent type id, or undefined when it is not known. */
export function useAgentTypeNames(): AgentTypeName {
  return useContext(AgentTypeNamesContext)
}

function agentTypeNamesFrom(types: ReadonlyArray<{ id: string; name: string }>): AgentTypeName {
  const names = new Map(types.filter((type) => type.name?.trim()).map((type) => [type.id, type.name.trim()]))
  return names.size ? (id) => names.get(id) : noAgentTypeNames
}
