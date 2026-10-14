import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { acquireDomHarness } from '../test/domHarness'
import { openPdfWith, type OpenPdf } from '../lib/pdfDocument'
import { attachmentPreviewMode } from '../lib/workflowAttachments'
import { PdfPreview } from './PdfPreview'

/** A minimal valid PDF with `pages` US-letter pages and a correct cross-reference table. */
function tinyPdf(pages: number): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>']
  const kids = Array.from({ length: pages }, (_, index) => `${3 + index * 2} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`)
  for (let index = 0; index < pages; index++) {
    const content = `BT /F1 24 Tf 72 720 Td (Page ${index + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + index * 2} 0 R >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = out.length
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A stand-in for pdf.js that records what it was asked to draw. */
function fakePdf(pages: number) {
  const drawn: Array<{ page: number; width: number; height: number; scale: number }> = []
  let destroyed = 0
  let opened: Uint8Array | undefined
  const open: OpenPdf = async (bytes) => {
    opened = bytes
    return {
      numPages: pages,
      destroy: async () => {
        destroyed++
      },
      getPage: async (page) => ({
        width: 612,
        height: 792,
        render(canvas, scale) {
          drawn.push({ page, width: canvas.width, height: canvas.height, scale })
          return { promise: Promise.resolve(), cancel() {} }
        },
      }),
    }
  }
  return { open, drawn, destroyed: () => destroyed, opened: () => opened }
}

/** An IntersectionObserver whose entries the test reports by hand. */
function controlledObserver() {
  const watched: Array<{ element: Element; callback: IntersectionObserverCallback }> = []
  const roots: Array<Element | Document | null | undefined> = []
  const original = globalThis.IntersectionObserver
  globalThis.IntersectionObserver = class {
    constructor(
      private callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit
    ) {
      roots.push(options?.root)
    }
    observe(element: Element) {
      watched.push({ element, callback: this.callback })
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
  const report = (index: number, isIntersecting: boolean) => {
    const { element, callback } = watched[index]!
    callback([{ isIntersecting, target: element } as IntersectionObserverEntry], {} as IntersectionObserver)
  }
  return {
    show: (index: number) => report(index, true),
    hide: (index: number) => report(index, false),
    count: () => watched.length,
    roots: () => roots,
    restore: () => {
      globalThis.IntersectionObserver = original
    },
  }
}

test('PDFs are previewed inline; HTML, SVG and unknown files still are not', () => {
  expect(attachmentPreviewMode({ filename: 'Design Review.PDF', byteSize: 9 * 1024 * 1024 })).toBe('pdf')
  expect(attachmentPreviewMode({ filename: 'page.html', byteSize: 10 })).toBe('download')
  expect(attachmentPreviewMode({ filename: 'icon.svg', byteSize: 10 })).toBe('download')
  expect(attachmentPreviewMode({ filename: 'notes.md', byteSize: 10 })).toBe('text')
})

test('the preview counts pages and draws each one to a canvas as it scrolls into view', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const observer = controlledObserver()
  const pdf = fakePdf(3)
  const bytes = new Uint8Array([1, 2, 3])
  try {
    const view = dom.createRoot()
    await dom.act(async () =>
      view.root.render(
        <div data-scroll-container>
          <PdfPreview bytes={bytes} fileName="design.pdf" openPdf={pdf.open} onError={() => {}} />
        </div>
      )
    )
    const doc = dom.window.document
    // Visibility is measured against the scrolling column, so the look-ahead margin applies there.
    expect(observer.roots()).toHaveLength(1)
    expect(observer.roots()[0] === doc.querySelector('[data-scroll-container]')).toBe(true)
    expect(doc.body.textContent).toContain('3 pages')
    expect(pdf.opened()).toBe(bytes)
    const canvases = [...doc.querySelectorAll('canvas')]
    expect(canvases).toHaveLength(3)
    expect(canvases.map((canvas) => canvas.getAttribute('aria-label'))).toEqual([
      'design.pdf, page 1 of 3',
      'design.pdf, page 2 of 3',
      'design.pdf, page 3 of 3',
    ])
    // Canvases scale to the column, so the phone layout gets the full width too.
    expect(canvases.every((canvas) => canvas.className.includes('w-full'))).toBe(true)
    expect(pdf.drawn).toEqual([])

    expect(observer.count()).toBe(3)
    await dom.act(async () => observer.show(1))
    expect(pdf.drawn.map((entry) => entry.page)).toEqual([2])
    // Drawn at the column width (the 800px fallback where layout is not measured) and device pixel ratio.
    expect(pdf.drawn[0]).toMatchObject({ width: 800, height: 1035, scale: 800 / 612 })

    await dom.act(async () => view.root.unmount())
    expect(pdf.destroyed()).toBe(1)
  } finally {
    observer.restore()
    await dom.cleanup()
  }
})

test('pages far from the view give up their canvas and draw again when they return', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const observer = controlledObserver()
  const pdf = fakePdf(12)
  try {
    const view = dom.createRoot()
    await dom.act(async () =>
      view.root.render(
        <PdfPreview bytes={new Uint8Array([1])} fileName="long.pdf" openPdf={pdf.open} onError={() => {}} />
      )
    )
    const canvases = [...dom.window.document.querySelectorAll('canvas')]
    await dom.act(async () => observer.show(0))
    expect(pdf.drawn.map((entry) => entry.page)).toEqual([1])
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([800, 1035])

    // Page 3 is still near: page 1 keeps its drawing.
    await dom.act(async () => {
      observer.hide(0)
      observer.show(2)
    })
    expect(canvases[0]!.width).toBe(800)

    // Page 10 is far: page 1 releases its bitmap but keeps its size, so scrolling does not jump.
    await dom.act(async () => {
      observer.hide(2)
      observer.show(9)
    })
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([0, 0])
    expect(canvases[0]!.style.aspectRatio).toBe('612 / 792')
    expect(canvases[9]!.width).toBe(800)

    await dom.act(async () => {
      observer.hide(9)
      observer.show(0)
    })
    expect(pdf.drawn.map((entry) => entry.page)).toEqual([1, 3, 10, 1])
    expect(canvases[0]!.width).toBe(800)
  } finally {
    observer.restore()
    await dom.cleanup()
  }
})

test('a PDF that cannot be opened reports the failure instead of rendering', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const errors: unknown[] = []
  try {
    const view = dom.createRoot()
    await dom.act(async () =>
      view.root.render(
        <PdfPreview
          bytes={new Uint8Array([0])}
          fileName="locked.pdf"
          openPdf={async () => {
            throw new Error('PasswordException')
          }}
          onError={(error) => errors.push(error)}
        />
      )
    )
    expect(errors.map((error) => (error as Error).message)).toEqual(['PasswordException'])
    expect(dom.window.document.querySelector('canvas')).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('pdf.js opens a real document from bytes alone and leaves the caller its bytes', async () => {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.worker.mjs'))
  const bytes = tinyPdf(2)
  const document = await openPdfWith(pdfjs, bytes)
  try {
    expect(document.numPages).toBe(2)
    const page = await document.getPage(2)
    expect([page.width, page.height]).toEqual([612, 792])
    // pdf.js transfers what it is given to its worker; the attachment's cached bytes must survive.
    expect(bytes.byteLength).toBeGreaterThan(0)
  } finally {
    await document.destroy()
  }
})
