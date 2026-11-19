import { draftBytes, type ProfileDraft } from '../voice/profileDraft'
import { ApiError } from '../../api/client'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PUBLIC_VOICE_MAX_BYTES, type Squad } from '@ficus/shared'
import { createPublicVoice, patchSquadVoice, publicVoiceQueryKeys } from '../../api/publicVoices'
import { queries } from '../../queryOptions'
import { AccountVoiceDerivation } from '../voice/AccountVoiceDerivation'
import { VoiceProfileDraftFields } from '../voice/VoiceProfileDraftFields'
import { useVoiceAccounts } from '../voice/voiceAccounts'
import { profileIdFromName } from '../voice/profileId'
import { pickMostRecentlyCreated } from './FirstSquadStep'

/** Optional, person-initiated setup. There is deliberately no server checklist state. */
export function PublicVoiceStep({
  githubDone,
  createdSquad,
  onConnectGitHub,
}: {
  githubDone: boolean
  createdSquad: Squad | null
  onConnectGitHub: () => void
}) {
  const client = useQueryClient()
  const { accounts } = useVoiceAccounts()
  const { data: squads = [] } = useQuery(queries.squads.list())
  const target = createdSquad ?? pickMostRecentlyCreated(squads)
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  // Capture the profile and target at the moment of creation, not at assignment retry time.
  const [saved, setSaved] = useState<{ id: string; name: string; target: Pick<Squad, 'id' | 'name'> | null } | null>(
    null
  )
  const [assignmentError, setAssignmentError] = useState('')
  const [complete, setComplete] = useState(false)
  const saving = useRef(false)
  const id = profileIdFromName(draft?.name ?? '')
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: publicVoiceQueryKeys.all }),
      client.invalidateQueries({ queryKey: queries.squads.list().queryKey }),
    ])
  const assign = async (profile: NonNullable<typeof saved>) => {
    setAssignmentError('')
    if (profile.target) {
      try {
        await patchSquadVoice(profile.target.id, { voiceId: profile.id })
      } catch (error) {
        setAssignmentError(
          error instanceof ApiError && typeof (error.payload as { error?: unknown })?.error === 'string'
            ? (error.payload as { error: string }).error
            : error instanceof Error
              ? error.message
              : String(error)
        )
        await refresh()
        return
      }
    }
    setComplete(true)
    await refresh()
  }
  const save = useMutation({
    mutationFn: async () => {
      if (!draft || saving.current || saved) return
      saving.current = true
      try {
        const profile = await createPublicVoice({
          id,
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          base: draft.base,
          surfaces: draft.surfaces,
        })
        const created = {
          id: profile.id,
          name: profile.name,
          target: target ? { id: target.id, name: target.name } : null,
        }
        setSaved(created)
        await assign(created)
      } finally {
        saving.current = false
      }
    },
  })
  const retry = useMutation({
    mutationFn: async () => {
      if (saved) await assign(saved)
    },
  })
  if (complete && saved)
    return (
      <p role="status" className="text-sm text-secondary">
        {saved.target
          ? `${saved.name} is now used by ${saved.target.name}.`
          : `Profile ${saved.name} saved. You can assign it from Settings → Voices.`}
      </p>
    )
  if (saved && !assignmentError)
    return (
      <p role="status" className="text-sm text-muted">
        Assigning {saved.name} to {saved.target?.name}…
      </p>
    )
  if (saved)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-status-danger-500">
          Profile saved; could not assign it to {saved.target?.name}: {assignmentError}
        </p>
        <button
          className="ficus-button ficus-button-secondary rounded px-3 py-1.5 text-sm"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          {retry.isPending ? 'Assigning…' : 'Retry assignment'}
        </button>
      </div>
    )
  if (!githubDone || !accounts.length)
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Derive how your agents write public text from your GitHub activity. Connect GitHub first.
        </p>
        <button className="ficus-button ficus-button-secondary rounded px-3 py-1.5 text-sm" onClick={onConnectGitHub}>
          Connect GitHub
        </button>
      </div>
    )
  return (
    <div className="space-y-3">
      <fieldset disabled={save.isPending}>
        <AccountVoiceDerivation
          onTargetChange={() => {
            if (!saving.current) {
              setDraft(null)
              save.reset()
            }
          }}
          onUseDraft={(voice) => {
            setDraft({ name: 'From GitHub', description: '', ...voice })
            save.reset()
          }}
        />
      </fieldset>
      {draft && (
        <div className="space-y-3 rounded-xl border border-panel-border p-4">
          <VoiceProfileDraftFields draft={draft} setDraft={setDraft} disabled={save.isPending} />
          <p className="text-xs text-muted">New profile id: {id}. Nothing is saved until you save the draft.</p>
          <p className="text-xs text-muted">
            {draftBytes(id, draft)} / {PUBLIC_VOICE_MAX_BYTES} bytes
          </p>
          {!target && (
            <p className="text-xs text-muted">
              You can assign this profile later from Settings → Voices. It will not be assigned automatically.
            </p>
          )}
          <button
            className="ficus-button ficus-button-primary rounded px-3 py-1.5 text-sm"
            disabled={
              save.isPending ||
              !draft.name.trim() ||
              !draft.base.trim() ||
              draftBytes(id, draft) > PUBLIC_VOICE_MAX_BYTES
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : target ? `Save and use for ${target.name}` : 'Save profile'}
          </button>
          {save.error && (
            <p role="alert" className="text-sm text-status-danger-500">
              {save.error instanceof Error ? save.error.message : String(save.error)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
