import { PRIMARY_SQUAD_TABS as PRIMARY } from '../../lib/squadNavigation'
import { Presence } from '../Presence'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
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
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const secondary = tabs.filter((tab) => !PRIMARY.has(tab.path))
  const selectedSecondary = secondary.find((tab) => tab.path === activeTab)
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"], [data-squad-menu-item]')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  return (
    <div className="squad-detail-tabs mb-4 flex shrink-0 items-center gap-0.5 border-b border-panel-border pb-2">
      <nav className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label="Squad sections">
        {tabs
          .filter((tab) => PRIMARY.has(tab.path))
          .map((tab) => (
            <button
              key={tab.path}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.path}
              onClick={() => onChange(tab.path)}
              className="ficus-button ficus-nav-item px-2 py-2.5 text-xs font-medium text-secondary sm:px-4 sm:text-sm"
            >
              {tab.label}
            </button>
          ))}
      </nav>
      <div
        ref={menuRef}
        className="relative shrink-0"
        onBlur={(event) => {
          // Touch browsers can blur a button with no new focus target before its click.
          // Outside pointers are handled above; dismiss here only for a known focus move.
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-label="More squad tools"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={clsx(
            'ficus-button flex max-w-20 sm:max-w-36 items-center gap-1 rounded-lg px-2 py-2.5 text-xs sm:text-sm',
            selectedSecondary ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover'
          )}
        >
          <span className="truncate">{selectedSecondary?.label ?? 'More'}</span>
          <ChevronDownIcon className="h-3 w-3 shrink-0" />
        </button>
        <Presence
          open={open}
          className="ficus-overlay absolute right-0 top-full z-30 mt-2 max-h-[60dvh] w-48 overflow-y-auto p-1.5"
        >
          <p className="ficus-section-title px-2 py-1.5">Squad tools</p>
          {secondary.map((tab) => (
            <button
              key={tab.path}
              type="button"
              data-squad-menu-item
              aria-current={activeTab === tab.path ? 'page' : undefined}
              onClick={() => {
                onChange(tab.path)
                setOpen(false)
                triggerRef.current?.focus()
              }}
              className={clsx(
                'ficus-button block w-full px-2.5 py-2 text-left text-sm hover:bg-surface-hover hover:text-primary focus-visible:bg-surface-hover focus-visible:text-primary active:bg-selection active:text-accent-light',
                activeTab === tab.path ? 'bg-selection text-accent-light' : 'text-secondary'
              )}
            >
              {tab.label}
            </button>
          ))}
        </Presence>
      </div>
    </div>
  )
}
