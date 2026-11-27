export type TabKey = 'feed' | 'squads' | 'inbox' | 'schedules' | 'settings'

export const TAB_ROOTS: ReadonlyArray<{ key: TabKey; root: string; prefixes: string[] }> = [
  { key: 'feed', root: '/', prefixes: ['/feed', '/actions'] },
  { key: 'squads', root: '/squads', prefixes: ['/squads'] },
  { key: 'inbox', root: '/inbox', prefixes: ['/inbox'] },
  { key: 'schedules', root: '/schedules', prefixes: ['/schedules'] },
  { key: 'settings', root: '/settings', prefixes: ['/settings'] },
]

const tabKeyByRoot: Record<string, TabKey> = {
  '/': 'feed',
  '/squads': 'squads',
  '/inbox': 'inbox',
  '/schedules': 'schedules',
  '/settings': 'settings',
}

const lastPathByTab = new Map<TabKey, string>()

export function getTabKey(pathWithSearch: string): TabKey | null {
  const pathname = pathWithSearch.split('?')[0] || '/'

  if (
    pathname === '/' ||
    pathname === '/feed' ||
    pathname.startsWith('/feed/') ||
    pathname === '/actions' ||
    pathname.startsWith('/actions/')
  ) {
    return 'feed'
  }

  for (const tab of TAB_ROOTS) {
    if (tab.key === 'feed') continue
    if (pathname === tab.root || pathname.startsWith(`${tab.root}/`)) return tab.key
  }

  return null
}

export function recordTabPath(pathWithSearch: string): void {
  const key = getTabKey(pathWithSearch)
  if (!key) return
  lastPathByTab.set(key, pathWithSearch)
}

export function getTabPath(key: TabKey): string {
  return lastPathByTab.get(key) ?? TAB_ROOTS.find((tab) => tab.key === key)!.root
}

export function getTabNavigationTarget(currentPathWithSearch: string, tabRoot: string): string {
  const tabKey = tabKeyByRoot[tabRoot]
  if (!tabKey) return tabRoot

  return getTabKey(currentPathWithSearch) === tabKey ? tabRoot : getTabPath(tabKey)
}

export function resetTabHistory(): void {
  lastPathByTab.clear()
}
