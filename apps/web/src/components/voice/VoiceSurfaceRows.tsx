import clsx from 'clsx'
import { PUBLIC_SURFACES, PUBLIC_SURFACE_LABELS, type PublicSurface, type PublicVoiceSurfaces } from '@ficus/shared'

type RowMode = 'inherit' | 'add' | 'override'

const MODE_LABELS: Record<RowMode, string> = {
  inherit: 'Inherit',
  add: 'Add to the voice',
  override: 'Replace the voice',
}

/**
 * One row per surface (commits, pull requests, review replies, issue comments,
 * channel messages): Inherit, Add to the voice, or Replace the voice, with its
 * text. An inherited row shows the entry it would inherit, greyed, so the
 * person sees what a squad entry would shadow.
 */
export function VoiceSurfaceRows({
  value,
  onChange,
  inherited,
  inheritLabel = 'Inherit',
  disabled,
}: {
  value: PublicVoiceSurfaces
  onChange: (next: PublicVoiceSurfaces) => void
  /** Entries from the profile underneath, shown greyed on inherited rows. */
  inherited?: PublicVoiceSurfaces
  /** "Inherit" for a squad layer; "None" for a profile, which has nothing underneath. */
  inheritLabel?: string
  disabled?: boolean
}) {
  const setRow = (surface: PublicSurface, mode: RowMode, text: string) => {
    const next = { ...value }
    if (mode === 'inherit') delete next[surface]
    else next[surface] = { mode, text }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {PUBLIC_SURFACES.map((surface) => {
        const entry = value[surface]
        const mode: RowMode = entry?.mode ?? 'inherit'
        const inheritedEntry = inherited?.[surface]
        return (
          <div key={surface} className="rounded-lg border border-th-border p-3" data-surface={surface}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm font-medium text-primary" htmlFor={`voice-surface-${surface}`}>
                {PUBLIC_SURFACE_LABELS[surface]}
              </label>
              <select
                id={`voice-surface-${surface}`}
                aria-label={`${PUBLIC_SURFACE_LABELS[surface]} mode`}
                className="ficus-field rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
                value={mode}
                disabled={disabled}
                onChange={(e) => setRow(surface, e.target.value as RowMode, entry?.text ?? inheritedEntry?.text ?? '')}
              >
                {(['inherit', 'add', 'override'] as const).map((option) => (
                  <option key={option} value={option}>
                    {option === 'inherit' ? inheritLabel : MODE_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
            {entry ? (
              <textarea
                aria-label={`${PUBLIC_SURFACE_LABELS[surface]} text`}
                value={entry.text}
                disabled={disabled}
                onChange={(e) => setRow(surface, entry.mode, e.target.value)}
                className={clsx(
                  'ficus-field mt-2 w-full rounded-md border border-th-border bg-surface p-2 text-sm text-primary',
                  'h-16 resize-y'
                )}
              />
            ) : inheritedEntry ? (
              <p className="mt-2 text-xs text-muted" data-inherited="true">
                {inheritedEntry.mode === 'override' ? 'Replaces the voice: ' : 'Adds: '}
                {inheritedEntry.text}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
