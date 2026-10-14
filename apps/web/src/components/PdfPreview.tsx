import { useEffect, useRef, useState } from 'react'
import { openPdf as openPdfDefault, type OpenPdf, type PdfDocument } from '../lib/pdfDocument'
import { useStableRef } from '../hooks/useStableRef'
import { DocumentSkeleton } from './loading/Skeleton'

/** Used when the column has no measured width yet (and in tests, which do no layout). */
const FALLBACK_WIDTH = 800

/** Pages draw this far ahead of the scroll container's edges. */
const LOOK_AHEAD = '400px 0px'

/** A drawn page keeps its bitmap while within this many pages of one near the view; farther ones release it. */
const KEEP_PAGES = 5

/**
 * A PDF drawn page by page into canvases that fill the column width. A page draws as it nears the view
 * of its scroll container (the closest `[data-scroll-container]`, else the viewport) and gives its bitmap
 * back once it is far away, so a long document holds only a window of canvases in memory. Renders from
 * bytes already fetched; pdf.js and its worker load on first use. A document that cannot be opened or
 * drawn (corrupt, encrypted) is reported through `onError`.
 */
export function PdfPreview({
  bytes,
  fileName,
  onError,
  openPdf = openPdfDefault,
}: {
  bytes: Uint8Array
  fileName: string
  onError: (error: unknown) => void
  openPdf?: OpenPdf
}) {
  const [document, setDocument] = useState<PdfDocument>()
  const onErrorRef = useStableRef(onError)
  useEffect(() => {
    let current: PdfDocument | undefined
    let closed = false
    openPdf(bytes).then(
      (opened) => {
        if (closed) void opened.destroy()
        else setDocument((current = opened))
      },
      (error: unknown) => {
        if (!closed) onErrorRef.current(error)
      }
    )
    return () => {
      closed = true
      setDocument(undefined)
      void current?.destroy()
    }
  }, [bytes, openPdf, onErrorRef])
  const near = usePagesNearView(document?.numPages ?? 0)
  if (!document) return <DocumentSkeleton label={`Loading ${fileName}`} lines={10} className="min-h-64" />
  const nearPages = [...near.pages]
  const first = Math.min(...nearPages)
  const last = Math.max(...nearPages)
  return (
    <div ref={near.container} className="space-y-3">
      <p className="text-xs text-muted">{document.numPages === 1 ? '1 page' : `${document.numPages} pages`}</p>
      {Array.from({ length: document.numPages }, (_, index) => index + 1).map((page) => (
        <PdfPageCanvas
          key={page}
          document={document}
          page={page}
          label={`${fileName}, page ${page} of ${document.numPages}`}
          draw={near.pages.has(page)}
          keep={nearPages.length > 0 && page >= first - KEEP_PAGES && page <= last + KEEP_PAGES}
          onError={onError}
        />
      ))}
    </div>
  )
}

/**
 * The pages near the view, from one IntersectionObserver rooted at the scroll container, so the look-ahead
 * margin applies to the column that actually scrolls. Without IntersectionObserver every page is near.
 */
function usePagesNearView(numPages: number) {
  const container = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<ReadonlySet<number>>(() => new Set())
  useEffect(() => {
    const element = container.current
    if (!element || !numPages) return
    if (typeof IntersectionObserver === 'undefined') {
      setPages(new Set(Array.from({ length: numPages }, (_, index) => index + 1)))
      return
    }
    const observer = new IntersectionObserver(
      (entries) =>
        setPages((previous) => {
          const next = new Set(previous)
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.pdfPage)
            if (entry.isIntersecting) next.add(page)
            else next.delete(page)
          }
          return next
        }),
      { root: element.closest('[data-scroll-container]'), rootMargin: LOOK_AHEAD }
    )
    for (const page of element.querySelectorAll('[data-pdf-page]')) observer.observe(page)
    return () => observer.disconnect()
  }, [numPages])
  return { container, pages }
}

function PdfPageCanvas({
  document,
  page,
  label,
  draw,
  keep,
  onError,
}: {
  document: PdfDocument
  page: number
  label: string
  /** The page is near the view: draw it unless it already is. */
  draw: boolean
  /** The page is within the kept window: hold its bitmap. */
  keep: boolean
  onError: (error: unknown) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)
  // Letter-shaped until the page is measured, then the page's own shape, kept after a release so the
  // placeholder holds its height and scrolling does not jump.
  const [aspectRatio, setAspectRatio] = useState('17 / 22')
  const onErrorRef = useStableRef(onError)
  useEffect(() => {
    const element = canvas.current
    if (!draw || drawn || !element) return
    let task: { cancel(): void } | undefined
    let closed = false
    document
      .getPage(page)
      .then((pdfPage) => {
        if (closed) return
        // Fill the column at device resolution; CSS then scales the canvas with the column.
        const width = element.parentElement?.clientWidth || FALLBACK_WIDTH
        element.width = Math.round(width * (window.devicePixelRatio || 1))
        const scale = element.width / pdfPage.width
        element.height = Math.round(pdfPage.height * scale)
        setAspectRatio(`${pdfPage.width} / ${pdfPage.height}`)
        const render = pdfPage.render(element, scale)
        task = render
        return render.promise.then(() => {
          if (!closed) setDrawn(true)
        })
      })
      .catch((error: unknown) => {
        // A cancelled render (scrolled away, unmounted) is not a failure.
        if (!closed) onErrorRef.current(error)
      })
    return () => {
      closed = true
      task?.cancel()
    }
  }, [draw, drawn, document, page, onErrorRef])
  useEffect(() => {
    const element = canvas.current
    if (keep || !drawn || !element) return
    // Zero dimensions free the backing bitmap; the page draws again when it comes back near.
    element.width = 0
    element.height = 0
    setDrawn(false)
  }, [keep, drawn])
  return (
    <div
      data-pdf-page={page}
      className="overflow-hidden rounded-md border border-panel-border bg-[rgb(var(--syntax-image-bg))]"
    >
      <canvas ref={canvas} role="img" aria-label={label} style={{ aspectRatio }} className="block h-auto w-full" />
    </div>
  )
}
