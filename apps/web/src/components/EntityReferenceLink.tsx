import type { Agent } from '@ficus/shared'
import { QueryClientContext } from '@tanstack/react-query'
import clsx from 'clsx'
import { lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EntityReference } from '../lib/entityReference'
import { REFERENCE_PREVIEW_OPEN_EVENT } from '@ficus/shared/browser-keys'

const loadReference = () => import('./EntityReferenceModal')
const EntityReferenceModal = lazy(() => loadReference().then((module) => ({ default: module.EntityReferenceModal })))

const EntityReferencePreview = lazy(() =>
  import('./EntityReferencePreview').then((module) => ({ default: module.EntityReferencePreview }))
)

export function EntityReferenceLink({
  reference,
  children,
  preloadOnVisible = true,
  onOpenAgent,
}: {
  reference: EntityReference
  children: ReactNode
  /** Compact feeds already materialize their content; resolve only on intent. */
  preloadOnVisible?: boolean
  /** Override agent navigation only after authorized reference resolution. */
  onOpenAgent?: (agent: Agent) => void
}) {
  const client = useContext(QueryClientContext)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState(false)
  const previewId = useId()
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focused = useRef(false)
  const hovered = useRef(false)
  const clearTimers = useCallback(() => {
    clearTimeout(showTimer.current)
    clearTimeout(hideTimer.current)
  }, [])
  const dismiss = useCallback(() => {
    if (document.getElementById(previewId)?.contains(document.activeElement))
      button.current?.focus({ preventScroll: true })
    clearTimers()
    setPreview(false)
  }, [clearTimers, previewId])
  const leave = () => {
    clearTimers()
    if (!focused.current && !hovered.current) hideTimer.current = setTimeout(() => setPreview(false), 150)
  }
  const { kind, id } = reference
  useEffect(() => {
    dismiss()
    return clearTimers
  }, [kind, id, dismiss, clearTimers])
  useEffect(() => {
    if (!preview) return
    // A new reference replaces an existing hover/focus preview instead of stacking cards.
    window.dispatchEvent(new Event(REFERENCE_PREVIEW_OPEN_EVENT))
    const close = () => {
      clearTimers()
      setPreview(false)
    }
    window.addEventListener(REFERENCE_PREVIEW_OPEN_EVENT, close)
    return () => window.removeEventListener(REFERENCE_PREVIEW_OPEN_EVENT, close)
  }, [preview, clearTimers])
  const preload = useCallback(() => {
    void loadReference()
      .then((module) => client && module.preloadEntityReference(client, { kind, id }))
      // Preloading is speculative; clicking still provides the normal retry/error UI.
      .catch(() => {})
  }, [client, kind, id])

  useEffect(() => {
    if (!preloadOnVisible || !button.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      preload()
    })
    observer.observe(button.current)
    return () => observer.disconnect()
  }, [preload, preloadOnVisible])

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-busy={loading}
        aria-haspopup={client ? 'dialog' : undefined}
        aria-expanded={client ? preview && !open : undefined}
        aria-controls={preview && client ? previewId : undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || event.shiftKey || !preview) return
          const link = document.getElementById(previewId)?.querySelector<HTMLAnchorElement>('a[href]')
          if (link) {
            event.preventDefault()
            link.focus()
          }
        }}
        className={clsx(
          'tau-button inline text-accent-light underline underline-offset-2',
          loading && 'motion-safe:animate-pulse motion-reduce:opacity-60'
        )}
        onMouseEnter={() => {
          preload()
          hovered.current = true
          clearTimers()
          if (!open) showTimer.current = setTimeout(() => setPreview(true), 250)
        }}
        onMouseLeave={() => {
          hovered.current = false
          leave()
        }}
        onFocus={() => {
          preload()
          focused.current = true
          clearTimers()
          if (!open && button.current?.matches(':focus-visible')) setPreview(true)
        }}
        onBlur={() => {
          focused.current = false
          leave()
        }}
        onTouchStart={preload}
        onClick={() => {
          dismiss()
          if (open) return
          setLoading(true)
          setOpen(true)
        }}
      >
        {children}
      </button>
      {preview && client && !open && (
        <Suspense fallback={null}>
          <EntityReferencePreview
            reference={reference}
            anchor={button}
            id={previewId}
            onEnter={() => {
              hovered.current = true
              clearTimers()
            }}
            onLeave={() => {
              hovered.current = false
              leave()
            }}
            onFocus={() => {
              focused.current = true
              clearTimers()
            }}
            onBlur={() => {
              focused.current = false
              leave()
            }}
            onDismiss={dismiss}
            onOpenAgent={onOpenAgent}
          />
        </Suspense>
      )}
      {open && (
        <Suspense fallback={null}>
          <EntityReferenceModal
            reference={reference}
            onOpenAgent={onOpenAgent}
            onResolved={() => setLoading(false)}
            onClose={() => {
              setOpen(false)
              setLoading(false)
            }}
          />
        </Suspense>
      )}
    </>
  )
}
