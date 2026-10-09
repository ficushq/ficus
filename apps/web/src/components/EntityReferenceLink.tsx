import type { Agent } from '@ficus/shared'
import { QueryClientContext } from '@tanstack/react-query'
import clsx from 'clsx'
import { lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EntityReference } from '../lib/entityReference'
import { REFERENCE_PREVIEW_OPEN_EVENT } from '@ficus/shared/browser-keys'
import { useHoverCard } from './popover/useHoverCard'

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
  // Hover opens the preview after 250ms, keyboard focus at once; leaving both it and the card closes it.
  const hover = useHoverCard({ openDelay: 250, closeDelay: 150 })
  const { open: preview, hide: dismiss } = hover
  const previewId = useId()
  // Once loaded, the card stays mounted so it can animate out; it renders nothing while closed.
  const [previewMounted, setPreviewMounted] = useState(false)
  if (preview && !previewMounted) setPreviewMounted(true)
  const { kind, id } = reference
  useEffect(() => dismiss(), [kind, id, dismiss])
  useEffect(() => {
    if (!preview) return
    // A new reference replaces an existing hover/focus preview instead of stacking cards.
    window.dispatchEvent(new Event(REFERENCE_PREVIEW_OPEN_EVENT))
    window.addEventListener(REFERENCE_PREVIEW_OPEN_EVENT, dismiss)
    return () => window.removeEventListener(REFERENCE_PREVIEW_OPEN_EVENT, dismiss)
  }, [preview, dismiss])
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
        className={clsx(
          'ficus-button ficus-button-link inline underline underline-offset-2',
          loading && 'motion-safe:animate-pulse motion-reduce:opacity-60'
        )}
        onMouseEnter={() => {
          preload()
          if (!open) hover.anchorHandlers.onMouseEnter()
        }}
        onMouseLeave={hover.anchorHandlers.onMouseLeave}
        onFocus={(event) => {
          preload()
          if (!open) hover.anchorHandlers.onFocus(event)
        }}
        onBlur={hover.anchorHandlers.onBlur}
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
      {previewMounted && client && (
        <Suspense fallback={null}>
          <EntityReferencePreview
            reference={reference}
            anchor={button}
            id={previewId}
            hover={hover}
            open={preview && !open}
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
