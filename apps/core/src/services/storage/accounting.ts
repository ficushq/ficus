import type { StorageAgent, StorageFolder, StorageGrowth, StorageSquad } from '@ficus/shared'

export interface StorageOwner {
  home: string
  squadId: string
  squadName: string
  label: string
  kind?: StorageFolder['kind']
  agent?: StorageAgent
}

const bySize = (a: { bytes: number | null }, b: { bytes: number | null }) => (b.bytes ?? -1) - (a.bytes ?? -1)

/**
 * A box home's folder tree from inclusive totals (path -> bytes). A folder whose
 * own total is missing shows the sum of its measured children as partial, so
 * missing totals never erase measured children nor read as zero. Paths in
 * `partial` (and their ancestors) are marked partial.
 */
export function buildFolderTree(
  home: string,
  entries: Map<string, number>,
  partial: Set<string> = new Set()
): StorageFolder {
  const nodes = new Map<string, Set<string>>([[home, new Set()]])
  const incomplete = new Set<string>()
  const addPath = (path: string, set: Set<string> | null) => {
    let current = path
    while (current !== home) {
      set?.add(current)
      if (!nodes.has(current)) nodes.set(current, new Set())
      const parent = current.slice(0, current.lastIndexOf('/'))
      if (!nodes.has(parent)) nodes.set(parent, new Set())
      nodes.get(parent)!.add(current)
      current = parent
    }
    set?.add(home)
  }
  for (const path of entries.keys()) if (path.startsWith(`${home}/`)) addPath(path, null)
  for (const path of partial) if (path === home || path.startsWith(`${home}/`)) addPath(path, incomplete)
  const folder = (path: string): StorageFolder => {
    const children = [...(nodes.get(path) ?? [])].map(folder).sort(bySize)
    const measured = children.filter((child) => child.bytes !== null)
    const own = entries.get(path)
    const bytes = own ?? (measured.length ? measured.reduce((sum, child) => sum + child.bytes!, 0) : null)
    return {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      bytes,
      status: bytes === null ? 'unavailable' : own === undefined || incomplete.has(path) ? 'partial' : 'available',
      children,
    }
  }
  return folder(home)
}

/** Per-home extras the view adds to each top-level folder. */
export interface HomeView {
  folder: StorageFolder
  measuredAt?: string
  freshness?: 'current' | 'previous'
  growth?: StorageGrowth
}

/**
 * Group box homes into squads, labelling each home for its owner. A home with
 * no measurement yet is shown as unavailable, never as zero.
 */
export function attributeStorage(homes: Map<string, HomeView>, owners: StorageOwner[]): StorageSquad[] {
  const squads = new Map<string, StorageSquad>()
  const seen = new Set<string>()
  for (const owner of owners) {
    if (seen.has(owner.home)) continue
    seen.add(owner.home)
    const view = homes.get(owner.home)
    const root: StorageFolder = view
      ? { ...structuredClone(view.folder), name: owner.label }
      : { name: owner.label, path: owner.home, bytes: null, status: 'unavailable', children: [] }
    if (owner.kind) root.kind = owner.kind
    if (owner.agent) root.agent = owner.agent
    if (view?.measuredAt) root.measuredAt = view.measuredAt
    if (view?.freshness) root.freshness = view.freshness
    if (view?.growth) root.growth = view.growth
    const squad = squads.get(owner.squadId) ?? {
      id: owner.squadId,
      name: owner.squadName,
      bytes: null,
      status: 'unavailable',
      folders: [],
    }
    squad.folders.push(root)
    squads.set(squad.id, squad)
  }
  return [...squads.values()]
    .map((squad): StorageSquad => {
      const measured = squad.folders.filter((item) => item.bytes !== null)
      const grown = squad.folders.filter((item) => item.growth)
      return {
        ...squad,
        bytes: measured.length ? measured.reduce((sum, item) => sum + item.bytes!, 0) : null,
        status: !measured.length
          ? 'unavailable'
          : squad.folders.every((item) => item.status === 'available')
            ? 'available'
            : 'partial',
        folders: squad.folders.sort(bySize),
        ...(grown.length
          ? {
              growth: {
                bytes: grown.reduce((sum, item) => sum + item.growth!.bytes, 0),
                since: grown.map((item) => item.growth!.since).sort()[0]!,
              },
            }
          : {}),
      }
    })
    .sort(bySize)
}
