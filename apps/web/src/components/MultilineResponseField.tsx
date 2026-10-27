import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { isSubmitShortcut, submitShortcutHint } from '../lib/submitShortcut'

interface MultilineResponseFieldProps {
  value: string
  onChange: (value: string) => void
  /** Called on Cmd/Ctrl+Enter when `canSubmit` holds and the value is not blank. */
  onSubmit: () => void
  /** Whether submitting is allowed right now (permission, no request in flight). Blank values never submit. */
  canSubmit: boolean
  placeholder?: string
  autoFocus?: boolean
  /** Buttons rendered in the row below the field, before the keyboard hint. */
  actions?: ReactNode
}

/**
 * Free-text response box for work stream input waits: a resizable textarea
 * where Enter adds a line and Cmd/Ctrl+Enter submits, matching the text
 * answer of an agent question (QuestionInput).
 */
export function MultilineResponseField({
  value,
  onChange,
  onSubmit,
  canSubmit,
  placeholder = 'Your response...',
  autoFocus,
  actions,
}: MultilineResponseFieldProps) {
  const [focused, setFocused] = useState(false)

  return (
    <div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!isSubmitShortcut(event)) return
          event.preventDefault()
          if (canSubmit && value.trim()) onSubmit()
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        rows={4}
        className={clsx(
          'ficus-field block w-full min-h-20 resize-y rounded-md border px-3 py-2',
          'border-input-border bg-input-bg text-primary focus:border-accent focus:ring-accent',
          'disabled:bg-surface-secondary text-base sm:text-sm'
        )}
      />
      {(actions || focused) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions}
          {focused && <p className="ml-auto text-xs text-placeholder">{submitShortcutHint()}</p>}
        </div>
      )}
    </div>
  )
}
