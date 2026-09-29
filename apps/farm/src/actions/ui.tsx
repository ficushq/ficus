import clsx from 'clsx'
import type { ReactNode } from 'react'
import { actionErrorMessage } from './api'

export type VerbTone = 'harvest' | 'prune' | 'primary' | 'quiet' | 'plain'

const TONE_CLASS: Record<VerbTone, string | undefined> = {
  harvest: 'g-button-harvest',
  prune: 'g-button-prune',
  primary: 'g-button-primary',
  quiet: 'g-button-quiet',
  plain: undefined,
}

interface VerbButtonProps {
  /** The farm verb ("Harvest"). */
  verb: string
  /** What the button really does ("Approve and deliver"); always visible and part of the name. */
  help: string
  tone?: VerbTone
  busy?: boolean
  /** Label while busy; defaults to the verb plus an ellipsis. */
  busyVerb?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
  onClick?: () => void
}

/** A chunky game button that always shows its plain meaning under the farm verb. */
export function VerbButton({
  verb,
  help,
  tone = 'plain',
  busy = false,
  busyVerb,
  disabled = false,
  type = 'button',
  title,
  onClick,
}: VerbButtonProps) {
  return (
    <button
      type={type}
      className={clsx('g-button', 'g-verb', TONE_CLASS[tone])}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      title={title}
      onClick={onClick}
    >
      <span className="g-verb-label">{busy ? (busyVerb ?? `${verb}…`) : verb}</span>
      <span className="g-verb-help">{help}</span>
    </button>
  )
}

/** Announced failure text for a mutation (or any error). */
export function ErrorNote({ error, message }: { error: unknown; message?: string }) {
  if (!error) return null
  return (
    <p role="alert" className="g-alert">
      {message ?? actionErrorMessage(error)}
    </p>
  )
}

export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="g-action-row">{children}</div>
}

/** Agent- or stream-authored text. Shown as plain wrapped text (the farm has no Markdown renderer). */
export function ActionText({ children }: { children: ReactNode }) {
  return <div className="g-action-text">{children}</div>
}
