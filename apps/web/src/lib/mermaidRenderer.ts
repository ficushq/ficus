/**
 * The Mermaid runtime. Import this module only through a dynamic `import()` so that Mermaid and its
 * diagram chunks load when a Markdown diagram is first shown, never in the initial bundle.
 *
 * It uses Mermaid's prebundled build rather than the package's main entry. The main entry imports
 * d3 modules that the app's charts also use, and the bundler would then move those shared modules,
 * including the parts only Mermaid needs, into chunks that load at startup.
 */
import mermaid from 'mermaid/dist/mermaid.esm.min.mjs'
import DOMPurify from 'dompurify'
import { mermaidConfig } from './mermaidConfig'

/** Wide diagrams shrink to fit the message only down to this share of their natural size, then scroll. */
const MIN_DIAGRAM_SCALE = 0.75

let sequence = 0
let queue: Promise<unknown> = Promise.resolve()

/**
 * Renders Mermaid source to a sanitized SVG string, rejecting when the source does not parse.
 *
 * Mermaid's configuration is global, so renders are serialized: each one applies its own theme
 * immediately before drawing and cannot pick up another diagram's theme halfway through.
 */
export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const run = async () => {
    const id = `ficus-mermaid-${++sequence}`
    mermaid.initialize(mermaidConfig(dark))
    try {
      const { svg } = await mermaid.render(id, source)
      // Defense in depth on top of strict mode: keep SVG markup only, never scripts or handlers.
      const fragment = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        RETURN_DOM_FRAGMENT: true,
      })
      const diagram = fragment.firstElementChild as SVGSVGElement | null
      if (diagram?.tagName.toLowerCase() !== 'svg') throw new Error('Mermaid did not produce an SVG diagram')
      // Mermaid draws at width 100% up to its natural width (the inline max-width).
      const naturalWidth = Number.parseFloat(diagram.style.maxWidth)
      if (naturalWidth > 0) diagram.style.minWidth = `${Math.round(naturalWidth * MIN_DIAGRAM_SCALE)}px`
      return diagram.outerHTML
    } finally {
      // A failed render can leave Mermaid's measuring element attached to the page.
      for (const leftover of [id, `d${id}`]) document.getElementById(leftover)?.remove()
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
