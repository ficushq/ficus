import { useId, type ReactNode } from 'react'

/** One explicit channel ID per row, using the same list controls as squad overrides. */
export function ChannelIdsEditor({
  kind,
  value,
  onChange,
  children,
  actions,
}: {
  kind: 'Allowed' | 'Denied' | 'Trusted'
  value: string[]
  onChange: (value: string[]) => void
  children: ReactNode
  actions?: ReactNode
}) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}>
      <div id={`${id}-label`} className="text-xs text-muted flex items-center gap-2 mb-0.5">
        <span>{kind} channel IDs</span>
        {actions}
      </div>
      <p id={`${id}-help`} className="text-xs text-muted mb-2">
        {children}
      </p>
      {value.length > 0 && (
        <div className="space-y-2 mb-2">
          {value.map((channelId, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={channelId}
                onChange={(event) => onChange(value.map((entry, i) => (i === index ? event.target.value : entry)))}
                aria-label={`${kind} channel ID ${index + 1}`}
                placeholder="Channel ID"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={200}
                className="ficus-field flex-1 min-w-0 text-sm px-2 py-1"
              />
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                aria-label={`Remove ${kind.toLowerCase()} channel ${index + 1}`}
                className="ficus-button text-xs text-muted hover:text-danger px-1 shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => onChange([...value, ''])}
        className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium"
      >
        + Add {kind.toLowerCase()} channel
      </button>
    </div>
  )
}
