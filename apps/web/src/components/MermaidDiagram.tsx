import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useThemeColors } from '../theme/useThemeColors'
import { isDarkColor } from '../theme/isDarkColor'

/** Renders Mermaid source to SVG markup, rejecting when the source is not a valid diagram. */
export type MermaidRenderer = (source: string, dark: boolean) => Promise<string>

/** Loads Mermaid on first use, so it is a separate chunk and never part of the initial bundle. */
const lazyMermaidRenderer: MermaidRenderer = (source, dark) =>
  import('../lib/mermaidRenderer').then(({ renderMermaid }) => renderMermaid(source, dark))

type RenderResult = { svg: string; error?: undefined } | { svg?: undefined; error: string }

/**
 * A Mermaid fence drawn as a diagram, with a toggle back to its source.
 *
 * The source code block (`fallback`) stays visible while Mermaid loads and whenever the diagram does
 * not parse, so the area is never blank and a failure never throws into the Markdown tree. The
 * diagram follows the app's light or dark surface and redraws when the theme changes.
 */
export function MermaidDiagram({
  source,
  fallback,
  renderer = lazyMermaidRenderer,
}: {
  source: string
  /** The ordinary code block for this fence. */
  fallback: ReactNode
  renderer?: MermaidRenderer
}) {
  const dark = isDarkColor(useThemeColors()['--color-bg-surface'])
  const [result, setResult] = useState<RenderResult>()
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let current = true
    let pending: Promise<string>
    try {
      pending = renderer(source, dark)
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending.then(
      (svg) => current && setResult({ svg }),
      (error: unknown) => current && setResult({ error: errorMessage(error) })
    )
    return () => {
      current = false
    }
  }, [source, dark, renderer])

  // Until the first render settles, and on a parse failure, the source is the content.
  if (!result?.svg) {
    return (
      <div data-mermaid={result?.error ? 'error' : 'loading'}>
        {fallback}
        {result?.error && (
          <p className="not-prose mt-1 whitespace-normal font-sans text-xs text-muted" title={result.error}>
            This Mermaid diagram could not be rendered, so its source is shown.
          </p>
        )}
      </div>
    )
  }

  return (
    // Markdown places code blocks inside <pre>, so restore the ordinary text font and wrapping.
    <div
      data-mermaid="rendered"
      className="not-prose my-2 whitespace-normal rounded border border-th-border bg-surface font-sans"
    >
      <div className="flex justify-end gap-1 px-1.5 pt-1.5" role="group" aria-label="Mermaid diagram view">
        {(['Diagram', 'Source'] as const).map((label) => {
          const pressed = (label === 'Source') === showSource
          return (
            <button
              key={label}
              type="button"
              aria-pressed={pressed}
              onClick={() => setShowSource(label === 'Source')}
              className={clsx(
                'ficus-button ficus-button-ghost px-1.5 py-0.5 text-xs font-medium',
                pressed ? 'text-primary' : 'text-muted'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
      {showSource ? (
        <div className="px-1.5 pb-1.5">{fallback}</div>
      ) : (
        // Mermaid scales the SVG down to the container width; the renderer stops that at a readable
        // size, and wider diagrams scroll horizontally instead of widening the message.
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="overflow-x-auto px-3 pb-3 [&_svg]:mx-auto [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      )}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
