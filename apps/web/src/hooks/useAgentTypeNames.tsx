import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { ApiError, getApiUrl } from '../api/client'
import { noAgentTypeNames, type AgentTypeName } from '../lib/agentDisplay'
import { readStoredAgentTypeNames, writeStoredAgentTypeNames } from '../lib/agentTypeNamesStorage'

const AgentTypeNamesContext = createContext<AgentTypeName>(noAgentTypeNames)

/** Agent type names change rarely; settings edits invalidate the list themselves. */
const AGENT_TYPE_NAMES_STALE_MS = 5 * 60_000

/**
 * Loads the squad's agent types once for the signed-in app, so every label names an agent by its
 * configured type name (`AgentType.name`). Until the read answers, labels use the names remembered
 * from the last read in this browser, so a page load does not show the title-cased id and then
 * switch. Without any names (first visit, or no permission to read agent types, which also forgets
 * the remembered ones) labels fall back to the title-cased type id.
 */
export function AgentTypeNamesProvider({ children }: { children: ReactNode }) {
  const { data, error } = useQuery({ ...queries.agentTypes.list(), retry: false, staleTime: AGENT_TYPE_NAMES_STALE_MS })
  // The backend is fixed for the life of the page, so the remembered names are read once.
  const [backend] = useState(() => getApiUrl())
  const [remembered] = useState(() => readStoredAgentTypeNames(backend))
  const refused = isRefused(error)
  const read = useMemo(() => (data ? namesById(data) : undefined), [data])

  useEffect(() => {
    if (read) writeStoredAgentTypeNames(backend, read)
    else if (refused) writeStoredAgentTypeNames(backend, {})
  }, [backend, read, refused])

  // An unreachable server keeps the remembered names; a refusal means this viewer may not read them.
  const current = read ?? (refused ? undefined : remembered)
  const typeNames = useMemo(() => (current ? agentTypeNamesFrom(current) : noAgentTypeNames), [current])
  return <AgentTypeNamesContext.Provider value={typeNames}>{children}</AgentTypeNamesContext.Provider>
}

/** Fixed names, for tests and previews that render without the signed-in app around them. */
export function StaticAgentTypeNames({ names, children }: { names: Record<string, string>; children: ReactNode }) {
  const typeNames = useMemo(
    () => agentTypeNamesFrom(namesById(Object.entries(names).map(([id, name]) => ({ id, name })))),
    [names]
  )
  return <AgentTypeNamesContext.Provider value={typeNames}>{children}</AgentTypeNamesContext.Provider>
}

/** The configured name for an agent type id, or undefined when it is not known. */
export function useAgentTypeNames(): AgentTypeName {
  return useContext(AgentTypeNamesContext)
}

function isRefused(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

function namesById(types: ReadonlyArray<{ id: string; name: string }>): Record<string, string> {
  return Object.fromEntries(types.filter((type) => type.name?.trim()).map((type) => [type.id, type.name.trim()]))
}

function agentTypeNamesFrom(names: Readonly<Record<string, string>>): AgentTypeName {
  const byId = new Map(Object.entries(names))
  return byId.size ? (id) => byId.get(id) : noAgentTypeNames
}
