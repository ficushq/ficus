import type { StorageFolder, StorageSquad } from '@ficus/shared'

export interface StorageOwner {
  home: string
  squadId: string
  squadName: string
  label: string
}

/** Only accept complete NUL-delimited records; interrupted output may end mid-path. */
export function parseDirectoryUsage(output: string): Map<string, number> {
  const entries = new Map<string, number>()
  for (const record of output.split('\0').slice(0, -1)) {
    const match = /^(\d+)\t(\/home(?:\/[^\0]*)?)$/.exec(record)
    if (!match) continue
    const bytes = Number(match[1])
    const path = match[2]
    if (
      !Number.isSafeInteger(bytes) ||
      path.includes('//') ||
      path.endsWith('/') ||
      path.split('/').some((part) => part === '.' || part === '..')
    )
      continue
    entries.set(path, bytes)
  }
  return entries
}

/** Preserve unfinished parents by summing only disjoint measured child subtrees.
 * du emits parents last. A missing home total must not erase already measured
 * children, nor turn an entirely unvisited home into a zero-byte measurement.
 */
export function attributeStorage(
  entries: Map<string, number>,
  owners: StorageOwner[],
  scanIncomplete = false
): StorageSquad[] {
  const squads = new Map<string, StorageSquad>()
  const homes = new Map<string, StorageOwner>()
  for (const owner of owners) if (!homes.has(owner.home)) homes.set(owner.home, owner)
  const nodes = new Map<string, Set<string>>()
  for (const home of homes.keys()) nodes.set(home, new Set())
  for (const path of entries.keys()) {
    const home = path.split('/').slice(0, 3).join('/')
    if (!homes.has(home)) continue
    let current = path
    while (current !== home) {
      if (!nodes.has(current)) nodes.set(current, new Set())
      const parent = current.slice(0, current.lastIndexOf('/'))
      if (!nodes.has(parent)) nodes.set(parent, new Set())
      nodes.get(parent)!.add(current)
      current = parent
    }
  }
  const bySize = (a: { bytes: number | null }, b: { bytes: number | null }) => (b.bytes ?? -1) - (a.bytes ?? -1)
  const folder = (path: string, name = path.slice(path.lastIndexOf('/') + 1)): StorageFolder => {
    const children = [...(nodes.get(path) ?? [])].map((child) => folder(child)).sort(bySize)
    const measured = children.filter((child) => child.bytes !== null)
    const rootBytes = entries.get(path)
    const bytes = rootBytes ?? (measured.length ? measured.reduce((sum, child) => sum + child.bytes!, 0) : null)
    return {
      name,
      path,
      bytes,
      status: bytes === null ? 'unavailable' : rootBytes === undefined || scanIncomplete ? 'partial' : 'available',
      children,
    }
  }
  for (const owner of homes.values()) {
    const root = folder(owner.home, owner.label)
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
      return {
        ...squad,
        bytes: measured.length ? measured.reduce((sum, item) => sum + item.bytes!, 0) : null,
        status: !measured.length
          ? 'unavailable'
          : squad.folders.every((item) => item.status === 'available')
            ? 'available'
            : 'partial',
        folders: squad.folders.sort(bySize),
      }
    })
    .sort(bySize)
}
