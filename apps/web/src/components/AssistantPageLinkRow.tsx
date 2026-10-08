import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { describeAppPath } from '../lib/assistantPageLinks'
import { ChatBubbleIcon, ChevronRightIcon, LinkIcon, SettingsIcon, SquadIcon, WorkStreamIcon } from './icons'

const ICONS = {
  page: LinkIcon,
  squad: SquadIcon,
  'work-stream': WorkStreamIcon,
  settings: SettingsIcon,
  conversation: ChatBubbleIcon,
} as const

/** A page the Assistant offered: its name, where it lives, and a chevron, like a conversation row. */
export function AssistantPageLinkRow({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const page = describeAppPath(path)
  const squad = useQuery({ ...queries.squads.basic(page.squadId ?? ''), enabled: Boolean(page.squadId) })
  const Icon = ICONS[page.kind]
  const context = squad.data?.name ?? page.context ?? 'Open page'
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      className="ficus-button ficus-button-secondary my-1 flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-selection"
      aria-label={`Go to ${page.title}${squad.data?.name ? ` in ${squad.data.name}` : ''}`}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{page.title}</span>
        <span className="block truncate text-xs text-muted">{context}</span>
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted" />
    </button>
  )
}
