import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { SQUAD_TABS } from '../lib/squadNavigation'
import { ActionPopup } from './ThemedPopup'
import { SquadAvatar } from './squads/SquadAvatar'
import { ChevronDownIcon } from './icons'

/** Squad sub-pages worth keeping when you switch squads: its tabs, plus the manager and consultant chats. */
const KEPT_PAGES = new Set<string>([...SQUAD_TABS.map((tab) => tab.path), 'manager', 'consultant'])

/**
 * Where switching to another squad lands: the same squad page you're on (Work
 * stays Work), without its query, which names things in the squad you left
 * (?ws=, ?agent=, ?file=…). Off a squad page, its home.
 */
export function squadSwitchPath(pathname: string, targetSlug: string): string {
  const [, root, , page] = pathname.split('/')
  const kept = root === 'squads' && page && page !== 'home' && KEPT_PAGES.has(page) ? `/${page}` : ''
  return `/squads/${targetSlug}${kept}`
}

/** The squad a path is on (its slug or id as written), if any. */
function currentSquadParam(pathname: string): string | undefined {
  const [, root, squad] = pathname.split('/')
  return root === 'squads' && squad ? decodeURIComponent(squad) : undefined
}

/** A chevron beside the top nav's Squads: jump to another squad, keeping the tab you're on. */
export function SquadSwitcher({ active }: { active: boolean }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { slugFor } = useSquadSlugs()
  const { data: squads = [] } = useQuery(queries.squads.list())
  const current = currentSquadParam(location.pathname)
  const visible = squads.filter((squad) => squad.status !== 'archived' && !squad.isAnonymous)
  if (visible.length === 0) return null
  return (
    <ActionPopup
      label="Switch squad"
      heading="Squads"
      width={240}
      className={
        active
          ? 'ficus-button ficus-button-ghost flex items-center rounded-none px-2 text-accent-light hover:text-accent-light hover:bg-accent/10'
          : 'ficus-button ficus-button-ghost flex items-center rounded-none px-2 hover:text-accent-light'
      }
      items={[
        ...visible.map((squad) => ({
          id: squad.id,
          label: squad.name,
          icon: <SquadAvatar name={squad.name} avatarUrl={squad.avatarUrl} size={20} />,
          active: current === squad.id || current === slugFor(squad.id),
          onSelect: () => navigate(squadSwitchPath(location.pathname, slugFor(squad.id))),
        })),
        { id: 'all-squads', label: 'All squads', onSelect: () => navigate('/squads') },
      ]}
    >
      <ChevronDownIcon className="h-3 w-3" />
    </ActionPopup>
  )
}
