import { useState } from 'react'
import { Markdown } from '../../chat/Markdown'

/** Past about this many characters or lines, text starts folded. */
const LONG_CHARS = 280
const LONG_LINES = 5

export function isLongText(text: string): boolean {
  return text.length > LONG_CHARS || text.split('\n').length > LONG_LINES
}

/**
 * Card text that folds to a few lines when long, with Show more / Show less.
 * Plain text keeps its line breaks and folds with a line clamp, so it never cuts
 * a word. `markdown` renders it (a work stream description is written in
 * markdown) and folds by height with a fade, since a line clamp can't span
 * headings and lists.
 */
export function ExpandableText({ text, label, markdown = false }: { text: string; label: string; markdown?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const long = isLongText(text)
  const folded = long && !expanded ? 'true' : undefined
  return (
    <div className="g-expandable">
      {markdown ? (
        <div className="g-expandable-md" data-folded={folded}>
          <Markdown className="g-card-md">{text}</Markdown>
        </div>
      ) : (
        <p className="g-card-text g-expandable-text" data-folded={folded}>
          {text}
        </p>
      )}
      {long && (
        <button
          type="button"
          className="g-link g-expandable-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Show less' : 'Show more'} of the ${label}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
