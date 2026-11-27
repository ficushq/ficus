import { AGENT_TYPE_NAMES_STORAGE_KEY } from '@ficus/shared/browser-keys'

/** Configured agent type names by type id, as last read from the server. */
export type StoredAgentTypeNames = Record<string, string>

type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>

/** One entry per backend, so a browser that talks to two instances never mixes their names. */
export function agentTypeNamesStorageKey(backend: string): string {
  return `${AGENT_TYPE_NAMES_STORAGE_KEY}:${backend}`
}

/** The names remembered from the last read, or none when nothing usable is stored. */
export function readStoredAgentTypeNames(
  backend: string,
  storage: ReadStorage | undefined = safeStorage()
): StoredAgentTypeNames {
  try {
    const value: unknown = JSON.parse(storage?.getItem(agentTypeNamesStorageKey(backend)) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const names: StoredAgentTypeNames = {}
    for (const [id, name] of Object.entries(value)) {
      if (typeof name === 'string' && name.trim()) names[id] = name.trim()
    }
    return names
  } catch {
    return {}
  }
}

/** Remembers the names from a read for the next page load; an empty list forgets them. */
export function writeStoredAgentTypeNames(
  backend: string,
  names: StoredAgentTypeNames,
  storage: WriteStorage | undefined = safeStorage()
): void {
  try {
    const key = agentTypeNamesStorageKey(backend)
    if (Object.keys(names).length) storage?.setItem(key, JSON.stringify(names))
    else storage?.removeItem(key)
  } catch {
    // Storage unavailable: the next page load shows title-cased ids until the read answers.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
