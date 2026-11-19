import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_PUBLIC_VOICE_ID, type Squad, type PublicVoiceProfileJson } from '@ficus/shared'
import { patchSquadVoice, publicVoiceQueryKeys } from '../../api/publicVoices'
import { ApiError } from '../../api/client'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'

export const CUSTOM_VOICE_ASSIGNMENT_NOTE =
  "uses its own custom voice; assigning a profile has no effect until that is cleared in the squad's Voice settings"

function AssignmentOption({
  squad,
  checked,
  disabled,
  onChange,
}: {
  squad: Squad
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const { can, isLoading } = usePermissions(squad.id)
  const readOnly = isLoading || !can('squads:update')
  return (
    <label data-squad-id={squad.id} className="block text-sm text-secondary">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />{' '}
      {squad.name}
      {readOnly && <span className="text-xs text-muted"> (read-only)</span>}
      {squad.publicVoice?.base && <span className="block text-xs text-muted">{CUSTOM_VOICE_ASSIGNMENT_NOTE}</span>}
    </label>
  )
}

/** Each PATCH remains independently authorized and size-checked. Successful changes survive a partial failure. */
export function SquadVoiceAssignments({
  profile,
  squads,
}: {
  profile: Pick<PublicVoiceProfileJson, 'id' | 'disabled'>
  squads: Squad[]
}) {
  const client = useQueryClient()
  const available = squads.filter((s) => !s.archivedAt)
  const isDefault = profile.id === DEFAULT_PUBLIC_VOICE_ID
  const usesProfile = (s: Squad) =>
    isDefault ? !s.publicVoiceId || s.publicVoiceId === DEFAULT_PUBLIC_VOICE_ID : s.publicVoiceId === profile.id
  const [edits, setEdits] = useState<Record<string, boolean>>({})
  const [failures, setFailures] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const changes = available.filter((s) => edits[s.id] !== undefined && edits[s.id] !== usesProfile(s))
  const apply = useMutation({
    mutationFn: async () => {
      const errors: string[] = []
      let successes = 0
      // Sequential, bounded to the selected squads; no bulk permission or transaction bypass.
      for (const squad of changes) {
        const voiceId = edits[squad.id] && !isDefault ? profile.id : null
        try {
          await patchSquadVoice(squad.id, { voiceId, preserveCustomBase: true })
          successes++
          client.setQueryData<Squad[]>(queries.squads.list().queryKey, (current) =>
            current?.map((s) => (s.id === squad.id ? { ...s, publicVoiceId: voiceId } : s))
          )
          setEdits((current) => {
            const next = { ...current }
            delete next[squad.id]
            return next
          })
        } catch (error) {
          errors.push(
            `${squad.name}: ${error instanceof ApiError ? `${error.message} (${error.status})` : String(error)}`
          )
        }
      }
      setFailures(errors)
      setNotice(successes ? `Updated ${successes} ${successes === 1 ? 'squad' : 'squads'}.` : '')
      await Promise.all([
        client.invalidateQueries({ queryKey: publicVoiceQueryKeys.all }),
        client.invalidateQueries({ queryKey: queries.squads.list().queryKey }),
      ])
    },
  })
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted">
        Assigned squads:{' '}
        {squads
          .filter((s) => s.publicVoiceId === profile.id)
          .map((s) => s.name)
          .join(', ') || 'None'}
      </p>
      {isDefault && (
        <p className="text-xs text-muted">
          Unassigned squads already use the instance default. Assigning default clears a squad's assignment.
        </p>
      )}
      <fieldset disabled={profile.disabled || apply.isPending} className="space-y-2">
        <legend className="text-sm font-medium text-primary">Assign to squads</legend>
        {available.map((squad) => (
          <AssignmentOption
            key={squad.id}
            squad={squad}
            checked={edits[squad.id] ?? usesProfile(squad)}
            disabled={profile.disabled || apply.isPending || (isDefault && !squad.publicVoiceId)}
            onChange={(checked) => setEdits((current) => ({ ...current, [squad.id]: checked }))}
          />
        ))}
        <button
          className="ficus-button ficus-button-secondary rounded px-3 py-1 text-sm"
          disabled={profile.disabled || !changes.length || apply.isPending}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? 'Applying…' : 'Apply assignments'}
        </button>
      </fieldset>
      {profile.disabled && <p className="text-xs text-muted">Disabled profiles cannot be assigned.</p>}
      {notice && (
        <p role="status" className="text-xs text-muted">
          {notice}
        </p>
      )}
      {failures.length > 0 && (
        <ul role="alert" className="text-xs text-status-danger-500">
          {failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
