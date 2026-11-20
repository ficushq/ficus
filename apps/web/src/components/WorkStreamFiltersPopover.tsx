import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ChevronDownIcon, CloseIcon } from './icons'
import { Panel, useHoverOpen, usePopover } from './popover'

/**
 * The Filters dropdown shared by the Feed and the squad Work tab. The trigger names what is
 * active ("Filters · In Review" for one choice, "Filters · 3" for several) and a Clear button
 * beside it resets every filter without opening the panel.
 */
export function WorkStreamFiltersPopover({
  count,
  activeLabel,
  onClear,
  label = 'Feed filters',
  align,
  children,
}: {
  count: number
  /** The one active choice's name, shown in the trigger when exactly one filter is on. */
  activeLabel?: string
  /** Resets every filter; the Clear button shows while any is on. */
  onClear?: () => void
  /** The panel's accessible name. */
  label?: string
  /** `start` when the trigger sits at the left of its row (the Work tab), so the panel opens rightward. */
  align?: 'start' | 'end'
  children: ReactNode
}) {
  const popover = usePopover({ kind: 'disclosure' })
  const hover = useHoverOpen(popover, { enabled: true })
  const summary = count === 1 && activeLabel ? activeLabel : count > 0 ? String(count) : null
  return (
    <div className="relative flex shrink-0 items-center gap-0.5" data-testid="work-stream-filters">
      <button
        {...popover.triggerProps}
        type="button"
        className={clsx(
          'ficus-button ficus-button-ghost flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs whitespace-nowrap transition-colors',
          count > 0 && 'bg-selection hover:bg-selection text-accent-light hover:text-accent-light'
        )}
        aria-label={summary ? `Filters, ${count === 1 && activeLabel ? activeLabel : `${count} active`}` : 'Filters'}
        {...hover.triggerProps}
      >
        Filters
        {summary && (
          <>
            <span aria-hidden>·</span>
            <span className="max-w-40 truncate font-medium">{summary}</span>
          </>
        )}
        <ChevronDownIcon className={clsx('h-3.5 w-3.5 transition-transform', popover.open && 'rotate-180')} />
      </button>
      {count > 0 && onClear && (
        <button
          type="button"
          className="ficus-button ficus-button-ghost rounded-md p-1 text-muted hover:text-primary"
          onClick={onClear}
          aria-label="Clear filters"
          title="Clear filters"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <Panel
        {...popover.popoverProps}
        {...hover.popoverProps}
        // Hover-opened, focus stays put; opened by click or keyboard, it moves to the first filter.
        initialFocus={hover.hoverOpened ? 'none' : (panel) => panel.querySelector('button')}
        role="region"
        label={label}
        align={align}
        gap={8}
        // At most 32rem, and never more than 70% of the visible viewport.
        maxHeight={(viewport) => Math.min(512, 0.7 * (viewport.bottom - viewport.top))}
        className="ficus-overlay w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-th-border bg-surface p-3 shadow-theme-lg"
      >
        {children}
      </Panel>
    </div>
  )
}

/** A titled group inside the Filters panel. */
export function WorkStreamFilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5" role="group" aria-label={title}>
      <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      {children}
    </div>
  )
}
