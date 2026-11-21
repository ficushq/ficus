import { draftBytes, type ProfileDraft } from '../voice/profileDraft'
import { ApiError } from '../../api/client'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PUBLIC_VOICE_MAX_BYTES, type Squad } from '@ficus/shared'
import { createPublicVoice, publicVoiceQueryKeys, setPublicVoiceInstanceDefault } from '../../api/publicVoices'
import { queries } from '../../queryOptions'
import { AccountVoiceDerivation } from '../voice/AccountVoiceDerivation'
import { VoiceProfileDraftFields } from '../voice/VoiceProfileDraftFields'
import { useVoiceAccounts } from '../voice/voiceAccounts'
import { profileIdFromName } from '../voice/profileId'

/** Squads that keep their voice when the instance default changes: an assigned profile or their own voice. */
function squadsKeepingTheirVoice(squads: Squad[]): Squad[] {
  return squads.filter((s) => !s.archivedAt && (s.publicVoiceId || s.publicVoice?.base))
}

/**
 * Optional, person-initiated setup. There is deliberately no server checklist state. Saving creates a
 * new profile and makes it the instance default, so every squad without an assigned profile or its
 * own voice uses it; squads with either keep theirs (no squad is changed).
 */
export function PublicVoiceStep({
  githubDone,
  onConnectGitHub,
}: {
  githubDone: boolean
  /** Unused here: the voice becomes the instance default rather than one squad's. Other steps use it. */
  createdSquad: Squad | null
  onConnectGitHub: () => void
}) {
  const client = useQueryClient()
  const { accounts, isPending: accountsPending, error: accountsError } = useVoiceAccounts()
  const { data: squads = [] } = useQuery(queries.squads.list())
  const keeping = squadsKeepingTheirVoice(squads)
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  // Capture the profile at the moment of creation, so a retry never recreates it.
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null)
  const [defaultError, setDefaultError] = useState('')
  const [complete, setComplete] = useState(false)
  const saving = useRef(false)
  const accountFields = useRef<HTMLFieldSetElement>(null)
  const id = profileIdFromName(draft?.name ?? '')
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: publicVoiceQueryKeys.all }),
      client.invalidateQueries({ queryKey: queries.squads.list().queryKey }),
    ])
  const makeDefault = async (profile: NonNullable<typeof saved>) => {
    setDefaultError('')
    try {
      await setPublicVoiceInstanceDefault(profile.id)
    } catch (error) {
      setDefaultError(
        error instanceof ApiError && typeof (error.payload as { error?: unknown })?.error === 'string'
          ? (error.payload as { error: string }).error
          : error instanceof Error
            ? error.message
            : String(error)
      )
      await refresh()
      return
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
        const created = { id: profile.id, name: profile.name }
        setSaved(created)
        await makeDefault(created)
      } finally {
        saving.current = false
      }
    },
  })
  const retry = useMutation({
    mutationFn: async () => {
      if (saved) await makeDefault(saved)
    },
  })
  if (complete && saved)
    return (
      <p role="status" className="text-sm text-secondary">
        {saved.name} is now the default voice. Every squad without an assigned profile or its own voice uses it; you can
        change the default in Settings → Voices.
      </p>
    )
  if (saved && !defaultError)
    return (
      <p role="status" className="text-sm text-muted">
        Making {saved.name} the default voice…
      </p>
    )
  if (saved)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-status-danger-500">
          Profile saved; could not make it the default voice: {defaultError}
        </p>
        <button
          className="ficus-button ficus-button-secondary rounded px-3 py-1.5 text-sm"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          {retry.isPending ? 'Saving…' : 'Retry setting as default'}
        </button>
      </div>
    )
  if (githubDone && (accountsPending || accountsError)) return <AccountVoiceDerivation />
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
      <fieldset ref={accountFields} disabled={save.isPending} hidden={Boolean(draft)}>
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
        <div className="space-y-3 rounded-xl border border-panel-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-primary">Review your voice</h4>
            <button
              className="ficus-button ficus-button-ghost px-2 py-1 text-sm"
              disabled={save.isPending}
              onClick={() => {
                setDraft(null)
                requestAnimationFrame(() =>
                  accountFields.current?.querySelector<HTMLInputElement>('[aria-label="GitHub login"]')?.focus()
                )
              }}
            >
              Back to derivation
            </button>
          </div>
          <VoiceProfileDraftFields draft={draft} setDraft={setDraft} disabled={save.isPending} />
          <p className="text-xs text-muted">New profile id: {id}. Nothing is saved until you save the draft.</p>
          <p className="text-xs text-muted">
            {draftBytes(id, draft)} / {PUBLIC_VOICE_MAX_BYTES} bytes
          </p>
          <p className="text-xs text-muted">
            Saving makes this profile the default voice: every squad without an assigned profile or its own voice uses
            it, including squads created later.
            {keeping.length > 0 &&
              ` ${keeping.map((s) => s.name).join(', ')} ${keeping.length === 1 ? 'keeps its' : 'keep their'} own voice setting.`}
          </p>
          <button
            className="ficus-button ficus-button-primary min-h-11 rounded px-3 py-1.5 text-sm sm:min-h-0"
            disabled={
              save.isPending ||
              !draft.name.trim() ||
              !draft.base.trim() ||
              draftBytes(id, draft) > PUBLIC_VOICE_MAX_BYTES
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save and use as default voice'}
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
