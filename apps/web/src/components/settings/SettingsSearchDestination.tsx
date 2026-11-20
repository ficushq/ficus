import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** Waits for query-backed content before revealing a linked field. Never changes its value. */
export function SettingsSearchDestination({
  section,
  target,
  fill = false,
  children,
}: {
  section: string
  target?: string
  /** Use the whole content area (width and height) instead of the readable form column, for tools such as Logs. */
  fill?: boolean
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = containerRef.current
    if (!container || !target) return
    let found: HTMLElement | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let originalTabIndex: string | null = null
    const opened = new Set<HTMLElement>()
    const reveal = () => {
      found = Array.from(container.querySelectorAll<HTMLElement>('[data-setting-target]')).find(
        (element) => element.dataset.settingTarget === target
      )
      if (!found) {
        const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-setting-reveal]')).find(
          (element) =>
            element.dataset.settingReveal?.split(' ').includes(target) && !element.disabled && !opened.has(element)
        )
        if (trigger) {
          opened.add(trigger)
          trigger.click()
          return
        }
        found = Array.from(container.querySelectorAll<HTMLElement>('[data-setting-fallback]')).find((element) =>
          element.dataset.settingFallback?.split(' ').includes(target)
        )
      }
      if (!found) return
      for (let ancestor = found.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true
      }
      originalTabIndex = found.getAttribute('tabindex')
      found.setAttribute('tabindex', '-1')
      found.setAttribute('data-setting-highlight', '')
      found.scrollIntoView?.({ block: 'center', behavior: 'auto' })
      found.focus({ preventScroll: true })
      observer.disconnect()
      timer = setTimeout(() => found?.removeAttribute('data-setting-highlight'), 3000)
    }
    const observer = new MutationObserver(reveal)
    observer.observe(container, { childList: true, subtree: true })
    reveal()
    return () => {
      observer.disconnect()
      clearTimeout(timer)
      found?.removeAttribute('data-setting-highlight')
      if (originalTabIndex === null) found?.removeAttribute('tabindex')
      else found?.setAttribute('tabindex', originalTabIndex)
    }
  }, [section, target])
  return (
    <div
      ref={containerRef}
      className={clsx(
        'min-w-0 w-full mx-auto py-4 px-1 md:py-2 md:px-4',
        fill ? 'flex min-h-full flex-col' : 'max-w-3xl'
      )}
    >
      {children}
    </div>
  )
}
