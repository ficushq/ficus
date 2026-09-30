import { PRIMARY_SQUAD_TABS as PRIMARY } from '../../lib/squadNavigation'
import { ActionPopup } from '../ThemedPopup'
import clsx from 'clsx'
import { ChevronDownIcon } from '../icons'

interface SquadTab {
  path: string
  label: string
}

export function SquadNavigation<T extends SquadTab>({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: readonly T[]
  activeTab: T['path']
  onChange: (tab: T['path']) => void
}) {
  const secondary = tabs.filter((tab) => !PRIMARY.has(tab.path))
  const selectedSecondary = secondary.find((tab) => tab.path === activeTab)
  return (
    <div className="squad-detail-tabs mb-4 flex shrink-0 items-center gap-0.5 border-b border-panel-border pb-2">
      {/* Scrolls sideways on narrow screens rather than squeezing the tabs; More stays pinned. */}
      <nav
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Squad sections"
      >
        {tabs
          .filter((tab) => PRIMARY.has(tab.path))
          .map((tab) => (
            <button
              key={tab.path}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.path}
              onClick={() => onChange(tab.path)}
              className="ficus-button ficus-nav-item shrink-0 whitespace-nowrap px-2 py-2.5 text-xs font-medium text-secondary sm:px-4 sm:text-sm"
            >
              {tab.label}
            </button>
          ))}
      </nav>
      <div className="shrink-0">
        <ActionPopup
          label="More squad tools"
          heading="Squad tools"
          className={clsx(
            'ficus-button flex max-w-20 sm:max-w-36 items-center gap-1 rounded-lg px-2 py-2.5 text-xs sm:text-sm',
            selectedSecondary ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover'
          )}
          items={secondary.map((tab) => ({
            id: tab.path,
            label: tab.label,
            active: activeTab === tab.path,
            onSelect: () => onChange(tab.path),
          }))}
        >
          <span className="truncate">{selectedSecondary?.label ?? 'More'}</span>
          <ChevronDownIcon className="h-3 w-3 shrink-0" />
        </ActionPopup>
      </div>
    </div>
  )
}
