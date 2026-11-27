import type { ReactNode } from 'react'

/**
 * Marks the asking robot's recommended option (ask_human `recommended: true`). Display only:
 * neither question card preselects it, and the person still chooses. Pick the option with the
 * shared `recommendedQuestionOption()`, so only the first flagged option is ever marked.
 */
export function RecommendedTag() {
  return <span className="g-recommended">Recommended</span>
}

/**
 * A radio or checkbox option's text: its label, plus the Recommended tag and the one-line reason
 * when it is the recommended option. The reason sits inside the option's label, so it is part of
 * the control's accessible name.
 */
export function OptionText({
  label,
  recommended,
  reason,
}: {
  label: ReactNode
  recommended: boolean
  reason?: string
}) {
  if (!recommended) return <span>{label}</span>
  return (
    <span className="g-option-text">
      <span className="g-option-name">
        {label} <RecommendedTag />
      </span>
      {reason && <span className="g-recommended-reason">{reason}</span>}
    </span>
  )
}
