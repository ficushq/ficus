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
      <input
        aria-label="Profile name"
        disabled={disabled}
        className="ficus-field w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        aria-label="Profile description"
        disabled={disabled}
        placeholder="Short description"
        className="ficus-field w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <textarea
        aria-label="Voice"
        disabled={disabled}
        className="ficus-field h-40 w-full rounded-md border border-th-border bg-surface p-2 text-sm text-primary"
        value={draft.base}
        onChange={(e) => setDraft({ ...draft, base: e.target.value })}
      />
      <VoiceSurfaceRows
        value={draft.surfaces}
        onChange={(surfaces) => setDraft({ ...draft, surfaces })}
        inheritLabel="None"
        disabled={disabled}
      />
    </div>
  )
}
