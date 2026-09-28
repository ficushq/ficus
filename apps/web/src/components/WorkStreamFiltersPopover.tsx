import clsx from 'clsx'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDownIcon } from './icons'

export function WorkStreamFiltersPopover({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        className={clsx(
          'ficus-button flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors',
          count > 0 ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover hover:text-primary'
        )}
        onClick={() => setOpen((current) => !current)}
      >
        Filters
        {count > 0 && <span className="font-medium">{count}</span>}
        <ChevronDownIcon className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-label="Feed filters"
          className="ficus-overlay absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-3rem)] max-h-[min(32rem,70dvh)] overflow-y-auto rounded-xl border border-th-border bg-surface p-3 shadow-theme-lg"
        >
          {children}
        </div>
      )}
    </div>
  )
}
