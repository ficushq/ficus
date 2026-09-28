import { Presence } from './Presence'
import clsx from 'clsx'
import { useEffect, useRef, useState, type ChangeEvent, type ComponentType } from 'react'
import { ChevronDownIcon, MoreIcon } from './icons'

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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pointerSelection = useRef(false)
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      pointerSelection.current = false
      if (event.key === 'Escape') {
        event.stopPropagation()
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  const handleSelectChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange(event.target.value as T)
  }

  const renderTabButton = (tab: AgentViewTabItem<T>, index: number) => {
    const Icon = tab.icon
    const isActive = activeTab === tab.value
    const activeCount = tab.activeCount ?? 0
    const activeLabel =
      activeCount > 0 ? `${tab.label}, ${activeCount} active subagent${activeCount === 1 ? '' : 's'}` : tab.label

    return (
      <button
        key={tab.value}
        onClick={() => onChange(tab.value)}
        aria-label={activeLabel}
        aria-pressed={isActive}
        className={clsx(
          'ficus-button',
          'flex items-center gap-1 px-2 py-1 text-xs font-medium transition-colors',
          index > 0 && 'border-l border-th-border',
          isActive ? 'bg-accent text-on-accent' : 'text-muted hover:text-primary hover:bg-surface-hover'
        )}
      >
        <Icon className="w-3.5 h-3.5" />
        {tab.label}
        {activeCount > 0 && (
          <span aria-hidden="true" className="shrink-0 inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-status-progress-500 animate-pulse" />
            <span
              className={clsx(
                'min-w-[16px] h-[16px] flex items-center justify-center text-[10px] font-bold rounded-full px-1 tabular-nums',
                isActive
                  ? 'bg-on-accent/20 text-on-accent'
                  : 'bg-status-progress-50 text-status-progress-700 dark:bg-status-progress-900/20 dark:text-status-progress-400'
              )}
            >
              {activeCount}
            </span>
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="ml-auto">
      <div
        ref={menuRef}
        className="relative md:hidden"
        onPointerDownCapture={() => {
          pointerSelection.current = true
        }}
        onBlur={(event) => {
          // Touch browsers may move focus to the page before the option's click.
          // Let an inside pointer finish selecting; outside pointers dismiss above.
          if (
            !pointerSelection.current &&
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            setMenuOpen(false)
        }}
      >
        <button
          type="button"
          ref={triggerRef}
          aria-label={`Conversation options, ${tabs.find((tab) => tab.value === activeTab)?.label ?? activeTab} view`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="ficus-button flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-primary"
        >
          <MoreIcon className="h-4 w-4" />
        </button>
        <Presence
          open={menuOpen}
          className="ficus-overlay absolute right-0 top-full z-30 mt-1 w-40 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
        >
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-current={activeTab === tab.value ? 'page' : undefined}
              onClick={() => {
                onChange(tab.value)
                setMenuOpen(false)
                triggerRef.current?.focus()
              }}
              className={clsx(
                'ficus-button',
                'block w-full rounded-md px-3 py-2 text-left text-sm',
                activeTab === tab.value ? 'bg-surface-hover text-primary' : 'text-secondary hover:bg-surface-hover'
              )}
            >
              {tab.label}
              {(tab.activeCount ?? 0) > 0 && ` (${tab.activeCount} active)`}
            </button>
          ))}
        </Presence>
      </div>
      <div className="relative hidden md:block lg:hidden">
        <select
          aria-label="Agent view"
          value={activeTab}
          onChange={handleSelectChange}
          className="ficus-field max-w-36 appearance-none rounded-md border border-th-border bg-surface py-1 pl-2 pr-7 text-xs font-medium text-primary  focus:ring-2 focus:ring-accent"
        >
          {tabs.map((tab) => {
            const activeCount = tab.activeCount ?? 0
            return (
              <option key={tab.value} value={tab.value}>
                {activeCount > 0 ? `${tab.label} (${activeCount} active)` : tab.label}
              </option>
            )
          })}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
      </div>
      <div className="hidden lg:flex border border-th-border rounded-md overflow-hidden">
        {tabs.map(renderTabButton)}
      </div>
    </div>
  )
}
