import { useState } from 'react'
import { MarkdownContent } from './MarkdownContent'

/** Characters of a long body shown before the Show more toggle appears — a few lines. */
export const COLLAPSED_MARKDOWN_LIMIT = 280

/**
 * A markdown body truncated with a Show more / Show less toggle — the affordance the app uses for
 * long delivered text (inbox cards, Assistant task updates). Short bodies render whole, no toggle.
 */
export function CollapsibleMarkdown({
  children,
  className,
  markdownClassName,
  limit = COLLAPSED_MARKDOWN_LIMIT,
}: {
  children: string
  className?: string
  markdownClassName?: string
  limit?: number
}) {
  const shouldCollapse = children.length > limit
  const [expanded, setExpanded] = useState(false)
  const visible = shouldCollapse && !expanded ? `${children.slice(0, limit).trimEnd()}…` : children
  return (
    <div className={className}>
      <MarkdownContent className={markdownClassName}>{visible}</MarkdownContent>
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="ficus-button ficus-button-ghost -ml-1.5 mt-1 px-1.5 py-0.5 text-xs font-medium"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
