import { useId, useState } from 'react'
import clsx from 'clsx'
import { isLongMarkdown, LONG_INSTRUCTIONS } from '../lib/workflowReview'
import { MarkdownContent } from './MarkdownContent'

/**
 * An embedded markdown document that never scrolls inside its container: short bodies render whole,
 * long ones start as a faded preview with a Show all / Show less toggle and grow in place.
 */
export function ExpandableMarkdown({
  children,
  className,
  markdownClassName,
  limit = LONG_INSTRUCTIONS,
  previewClassName = 'max-h-28',
  label,
}: {
  children: string
  className?: string
  markdownClassName?: string
  limit?: { characters: number; lines: number }
  /** The collapsed height. */
  previewClassName?: string
  /** What the toggle reveals, for assistive technology ("instructions"). */
  label?: string
}) {
  const long = isLongMarkdown(children, limit)
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const collapsed = long && !expanded
  return (
    <div className={className}>
      <div
        id={id}
        data-collapsed={collapsed || undefined}
        className={clsx(collapsed && ['overflow-hidden ficus-fade-bottom', previewClassName])}
      >
        <MarkdownContent variant="document" className={markdownClassName}>
          {children}
        </MarkdownContent>
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={label ? `${expanded ? 'Show less' : 'Show all'} ${label}` : undefined}
          onClick={() => setExpanded((value) => !value)}
          className="ficus-button ficus-button-link mt-1.5 text-xs font-medium"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}
