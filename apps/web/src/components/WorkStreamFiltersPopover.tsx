import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ChevronDownIcon } from './icons'
import { Panel, usePopover } from './popover'

export function WorkStreamFiltersPopover({ count, children }: { count: number; children: ReactNode }) {
  const popover = usePopover({ kind: 'disclosure' })
  return (
    <div className="relative">
      <button
        {...popover.triggerProps}
        type="button"
        className={clsx(
          'ficus-button flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors',
          count > 0 ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover hover:text-primary'
        )}
        onClick={popover.toggle}
      >
        Filters
        {count > 0 && <span className="font-medium">{count}</span>}
        <ChevronDownIcon className={clsx('h-3.5 w-3.5 transition-transform', popover.open && 'rotate-180')} />
      </button>
      <Panel
        {...popover.popoverProps}
        role="region"
        label="Feed filters"
        gap={8}
        initialFocus={(panel) => panel.querySelector('button')}
        // At most 32rem, and never more than 70% of the visible viewport.
        maxHeight={(viewport) => Math.min(512, 0.7 * (viewport.bottom - viewport.top))}
        className="ficus-overlay w-80 rounded-xl border border-th-border bg-surface p-3 shadow-theme-lg"
      >
        {children}
      </Panel>
    </div>
  )
}
