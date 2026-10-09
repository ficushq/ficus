import { useId, type ReactNode } from 'react'

export const DECISION_INPUT_CLASS =
  'ficus-field w-full min-w-0 rounded border border-th-border bg-surface px-3 py-2 text-sm text-primary'

/** A labelled form field whose hint stays out of the control's accessible name. */
export function DecisionField({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: ReactNode
  className?: string
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className={className ?? 'min-w-0 space-y-1'}>
      <label htmlFor={id} className="block text-xs font-medium text-secondary">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  )
}
