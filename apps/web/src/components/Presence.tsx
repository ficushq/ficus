import { useEffect, useState } from 'react'
import type { HTMLAttributes, Ref } from 'react'
import clsx from 'clsx'

/** Keeps a dismissed surface only for its exit animation, with interaction disabled. */
export function Presence({
  open,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { open: boolean; ref?: Ref<HTMLDivElement> }) {
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)

  useEffect(() => {
    if (open || !present) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false)
      return
    }
    // Cleanup fallback also covers a stylesheet failing to load or animation cancellation.
    const timeout = window.setTimeout(() => setPresent(false), 160)
    return () => window.clearTimeout(timeout)
  }, [open, present])

  if (!open && !present) return null
  return (
    <div
      {...props}
      className={clsx('ficus-presence', className)}
      data-state={open ? 'open' : 'closed'}
      inert={!open || undefined}
      aria-hidden={!open || undefined}
      onAnimationEnd={(event) => {
        if (!open && event.target === event.currentTarget) setPresent(false)
      }}
    >
      {children}
    </div>
  )
}
