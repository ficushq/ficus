import type * as Pdfjs from 'pdfjs-dist'

/** One page, measured at scale 1 (CSS pixels), that can draw itself into a canvas. */
export interface PdfPage {
  width: number
  height: number
  /** Draw at `scale` into `canvas`; the caller sizes the canvas. */
  render(canvas: HTMLCanvasElement, scale: number): { promise: Promise<unknown>; cancel(): void }
}

export interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
  destroy(): Promise<void>
}

export type OpenPdf = (bytes: Uint8Array) => Promise<PdfDocument>

/**
 * Open a PDF from bytes already in hand. Nothing is fetched: no document URL, range or stream
 * requests, and no CMap, standard-font, ICC or wasm downloads (fonts the file does not embed fall
 * back to system fonts). Annotations are drawn into the page image only; there is no link layer.
 */
export async function openPdfWith(pdfjs: typeof Pdfjs, bytes: Uint8Array): Promise<PdfDocument> {
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker; a copy keeps the caller's bytes usable.
    data: bytes.slice(),
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    stopAtErrors: true,
  })
  try {
    const document = await task.promise
    return {
      numPages: document.numPages,
      destroy: () => task.destroy(),
      async getPage(pageNumber) {
        const page = await document.getPage(pageNumber)
        const { width, height } = page.getViewport({ scale: 1 })
        return {
          width,
          height,
          render(canvas, scale) {
            const task = page.render({
              canvas,
              viewport: page.getViewport({ scale }),
              annotationMode: pdfjs.AnnotationMode.ENABLE,
            })
            return { promise: task.promise, cancel: () => task.cancel() }
          },
        }
      },
    }
  } catch (error) {
    await task.destroy().catch(() => {})
    throw error
  }
}

let loading: Promise<typeof Pdfjs> | undefined

/** pdf.js and its worker load on first use, as their own chunks outside the main bundle. */
function loadPdfjs(): Promise<typeof Pdfjs> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    },
    (error: unknown) => {
      loading = undefined
      throw error
    }
  )
  return loading
}

export const openPdf: OpenPdf = async (bytes) => openPdfWith(await loadPdfjs(), bytes)
