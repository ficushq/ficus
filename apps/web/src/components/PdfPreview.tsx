import { useEffect, useRef, useState } from 'react'
import { openPdf as openPdfDefault, type OpenPdf, type PdfDocument } from '../lib/pdfDocument'
import { useStableRef } from '../hooks/useStableRef'
import { DocumentSkeleton } from './loading/Skeleton'

/** Used when the column has no measured width yet (and in tests, which do no layout). */
const FALLBACK_WIDTH = 800

/**
 * A PDF drawn page by page into canvases that fill the column width, each page rendered only when it
 * scrolls near the view. Renders from bytes already fetched; pdf.js and its worker load on first use.
 * A document that cannot be opened (corrupt, encrypted) is reported through `onError`.
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
  if (!document) return <DocumentSkeleton label={`Loading ${fileName}`} lines={10} className="min-h-64" />
  const pages = Array.from({ length: document.numPages }, (_, index) => index + 1)
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">{document.numPages === 1 ? '1 page' : `${document.numPages} pages`}</p>
      {pages.map((page) => (
        <PdfPageCanvas
          key={page}
          document={document}
          page={page}
          label={`${fileName}, page ${page} of ${document.numPages}`}
          onError={onError}
        />
      ))}
    </div>
  )
}

function PdfPageCanvas({
  document,
  page,
  label,
  onError,
}: {
  document: PdfDocument
  page: number
  label: string
  onError: (error: unknown) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  // Letter-shaped until the page is measured, so pages below hold their place while scrolling.
  const [aspectRatio, setAspectRatio] = useState('17 / 22')
  const onErrorRef = useStableRef(onError)
  useEffect(() => {
    const element = canvas.current
    if (!element || visible) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '400px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    const element = canvas.current
    if (!visible || !element) return
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
        return render.promise
      })
      .catch((error: unknown) => {
        // A cancelled render (unmount, document change) is not a failure.
        if (!closed) onErrorRef.current(error)
      })
    return () => {
      closed = true
      task?.cancel()
    }
  }, [visible, document, page, onErrorRef])
  return (
    <div className="overflow-hidden rounded-md border border-panel-border bg-[rgb(var(--syntax-image-bg))]">
      <canvas ref={canvas} role="img" aria-label={label} style={{ aspectRatio }} className="block h-auto w-full" />
    </div>
  )
}
