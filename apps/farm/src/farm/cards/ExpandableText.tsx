import { useState } from 'react'

/** Past about this many characters or lines, text starts folded. */
const LONG_CHARS = 280
const LONG_LINES = 5

export function isLongText(text: string): boolean {
  return text.length > LONG_CHARS || text.split('\n').length > LONG_LINES
}

/**
 * Card text that folds to a few lines when long, with Show more / Show less.
 * Line breaks are kept. Folding is CSS (a line clamp), so it never cuts a word.
 */
export function ExpandableText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = isLongText(text)
  return (
    <div className="g-expandable">
      <p className="g-card-text g-expandable-text" data-folded={long && !expanded ? 'true' : undefined}>
        {text}
      </p>
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
