import { VoiceDisclosure } from './VoiceDisclosure'
import type { ProfileDraft } from './profileDraft'
import { VoiceSurfaceRows } from './VoiceSurfaceRows'

/** Shared editable draft fields; saving is explicitly owned by the calling surface. */
export function VoiceProfileDraftFields({
  draft,
  setDraft,
  disabled = false,
}: {
  draft: ProfileDraft
  setDraft: (draft: ProfileDraft) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <label className="block text-xs text-muted">
        Profile name
        <input
          aria-label="Profile name"
          autoFocus={!disabled}
          disabled={disabled}
          className="ficus-field mt-1 min-h-11 w-full sm:min-h-0 rounded-md border border-th-border bg-surface px-2 py-1 text-base text-primary sm:text-sm"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="block text-xs text-muted">
        Description (optional)
        <input
          aria-label="Profile description"
          disabled={disabled}
          placeholder="Short description"
          className="ficus-field mt-1 min-h-11 w-full sm:min-h-0 rounded-md border border-th-border bg-surface px-2 py-1 text-base text-primary sm:text-sm"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <label className="block text-xs text-muted">
        Voice instructions
        <textarea
          aria-label="Voice"
          disabled={disabled}
          className="ficus-field mt-1 h-40 w-full rounded-md border border-th-border bg-surface p-2 text-base text-primary sm:text-sm"
          value={draft.base}
          onChange={(e) => setDraft({ ...draft, base: e.target.value })}
        />
      </label>
      <VoiceDisclosure
        summary={
          <>
            Surface instructions{' '}
            <span className="font-normal text-muted">({Object.keys(draft.surfaces).length} configured)</span>
          </>
        }
      >
        <div className="mt-3">
          <VoiceSurfaceRows
            value={draft.surfaces}
            onChange={(surfaces) => setDraft({ ...draft, surfaces })}
            inheritLabel="None"
            disabled={disabled}
          />
        </div>
      </VoiceDisclosure>
    </div>
  )
}
