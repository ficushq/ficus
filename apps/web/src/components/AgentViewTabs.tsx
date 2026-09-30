import { ActionPopup, SelectionPopup } from './ThemedPopup'
import clsx from 'clsx'
import { type ComponentType } from 'react'
import { ChevronDownIcon, MoreIcon } from './icons'
import { SegmentedControl } from './SegmentedControl'

export interface AgentViewTabItem<T extends string> {
  value: T
  label: string
  icon: ComponentType<{ className?: string }>
  /** Active subagents shown as a status indicator. */
  activeCount?: number
  secondary?: boolean
}

interface AgentViewTabsProps<T extends string> {
  activeTab: T
  onChange: (tab: T) => void
  tabs: AgentViewTabItem<T>[]
  collapseOnMobile?: boolean
}

export function AgentViewTabs<T extends string>({ activeTab, onChange, tabs }: AgentViewTabsProps<T>) {
  const viewLabel = (tab: AgentViewTabItem<T>) =>
    (tab.activeCount ?? 0) > 0
      ? `${tab.label}, ${tab.activeCount} active subagent${tab.activeCount === 1 ? '' : 's'}`
      : tab.label
  const currentTab = tabs.find((tab) => tab.value === activeTab)
  const options = tabs.map((tab) => ({
    value: tab.value,
    label: (tab.activeCount ?? 0) > 0 ? `${tab.label} (${tab.activeCount} active)` : tab.label,
    ariaLabel: viewLabel(tab),
  }))

  return (
    <div className="ml-auto">
      <div className="md:hidden">
        <ActionPopup
          label={`Conversation options, ${currentTab?.label ?? activeTab} view`}
          className="ficus-button flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary"
          items={options.map((option) => ({
            ...option,
            id: option.value,
            active: option.value === activeTab,
            onSelect: () => onChange(option.value),
          }))}
        >
          <MoreIcon className="h-4 w-4" />
        </ActionPopup>
      </div>
      <div className="hidden md:block lg:hidden">
        <SelectionPopup
          label="Agent view"
          value={activeTab}
          onChange={onChange}
          options={options}
          className="ficus-button flex max-w-36 items-center gap-2 rounded-md border border-th-border bg-surface px-2 py-1 text-xs font-medium text-primary"
        >
          <span className="truncate">{options.find((option) => option.value === activeTab)?.label ?? activeTab}</span>
          <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" />
        </SelectionPopup>
      </div>
      <SegmentedControl
        size="compact"
        ariaLabel="Agent view"
        className="hidden lg:inline-flex"
        value={activeTab}
        onChange={onChange}
        options={tabs.map((tab) => {
          const activeCount = tab.activeCount ?? 0
          return {
            value: tab.value,
            label: tab.label,
            Icon: tab.icon,
            ariaLabel: viewLabel(tab),
            badge:
              activeCount > 0
                ? (selected: boolean) => (
                    <span aria-hidden="true" className="shrink-0 inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-progress-500 animate-pulse" />
                      <span
                        className={clsx(
                          'min-w-[16px] h-[16px] flex items-center justify-center text-[10px] font-bold rounded-full px-1 tabular-nums',
                          selected
                            ? 'bg-on-accent/20 text-on-accent'
                            : 'bg-status-progress-50 text-status-progress-700 dark:bg-status-progress-900/20 dark:text-status-progress-400'
                        )}
                      >
                        {activeCount}
                      </span>
                    </span>
                  )
                : undefined,
          }
        })}
      />
    </div>
  )
}
