import { useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_SURFACES,
  PUBLIC_SURFACE_LABELS,
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceBytes,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  type PublicSurface,
  type PublicVoiceSurfaces,
  type SquadPublicVoicePatch,
  type SquadPublicVoiceState,
} from '@ficus/shared'
import {
  createPublicVoice,
  getSquadVoice,
  patchSquadVoice,
  previewSquadVoice,
  publicVoiceQueryKeys,
} from '../../api/publicVoices'
import { ApiError } from '../../api/client'
import { usePermissions } from '../../hooks/usePermissions'
import { useAdjustOnChange } from '../../hooks/useAdjustOnChange'
import { VoiceSurfaceRows } from '../voice/VoiceSurfaceRows'
import { DeriveVoiceCard } from '../voice/DeriveVoiceCard'

const INSTANCE = '__instance__'
const CUSTOM = '__custom__'

/** The picker value for a stored state: the instance default, a profile, or the squad's own voice. */
export function pickerValueFor(state: Pick<SquadPublicVoiceState, 'voiceId' | 'local'>): string {
  if (state.local.base) return CUSTOM
  return state.voiceId ?? INSTANCE
}

/**
 * The rendered size of an edited voice, computed with the same shared
 * renderer the server uses. Null when the picked profile's text is not loaded
 * (a different profile than the stored one), so the size is known after saving.
 */
export function draftBytes(
  state: SquadPublicVoiceState,
  picker: string,
  customBase: string,
  surfaces: PublicVoiceSurfaces
): number | null {
  const squad = { base: picker === CUSTOM ? customBase.trim() || null : null, surfaces }
  if (picker === CUSTOM) return publicVoiceBytes(renderPublicVoicePrompt(resolvePublicVoice({ squad, assigned: null, instanceDefault: null })))
  const storedPicker = state.local.base ? CUSTOM : (state.voiceId ?? INSTANCE)
  const pickedProfileId = picker === INSTANCE ? DEFAULT_PUBLIC_VOICE_ID : picker
  const profile = state.profile && (picker === storedPicker || state.profile.id === pickedProfileId) ? state.profile : null
  if (!profile) return null
  return publicVoiceBytes(renderPublicVoicePrompt(resolvePublicVoice({ squad, assigned: profile, instanceDefault: null })))
}

/** The PATCH that turns the stored state into the edited one. */
export function buildVoicePatch(picker: string, customBase: string, surfaces: PublicVoiceSurfaces): SquadPublicVoicePatch {
  const allSurfaces = Object.fromEntries(PUBLIC_SURFACES.map((s) => [s, surfaces[s] ?? null])) as SquadPublicVoicePatch['surfaces']
  if (picker === CUSTOM) return { base: customBase.trim(), surfaces: allSurfaces }
  return { voiceId: picker === INSTANCE ? null : picker, base: null, surfaces: allSurfaces }
}

/** Squad settings → Voice: how this squad's agents sound in public text. See docs/wiki/public-voice.md. */
export function SquadVoiceSettings({ squadId }: { squadId: string }) {
  const { data: state, error } = useQuery({ queryKey: publicVoiceQueryKeys.squad(squadId), queryFn: () => getSquadVoice(squadId) })
  if (error) return <p className="text-sm text-status-danger-500">Could not load the voice: {String(error)}</p>
  if (!state) return <p className="text-sm text-muted">Loading voice…</p>
  return <SquadVoiceEditor squadId={squadId} state={state} />
}

export function SquadVoiceEditor({ squadId, state }: { squadId: string; state: SquadPublicVoiceState }) {
  const queryClient = useQueryClient()
  const { can, isLoading } = usePermissions(squadId)
  const canEdit = !isLoading && can('squads:update')
  const canManageProfiles = !isLoading && can('agent-types:update')

  const [picker, setPicker] = useState(pickerValueFor(state))
  const [customBase, setCustomBase] = useState(state.local.base ?? '')
  const [surfaces, setSurfaces] = useState<PublicVoiceSurfaces>(state.local.surfaces)
  useAdjustOnChange([state], () => {
    setPicker(pickerValueFor(state))
    setCustomBase(state.local.base ?? '')
    setSurfaces(state.local.surfaces)
  })

  const [previewSurface, setPreviewSurface] = useState<PublicSurface>('pullRequests')
  const [sample, setSample] = useState('')

  const save = useMutation({
    mutationFn: () => patchSquadVoice(squadId, buildVoicePatch(picker, customBase, surfaces)),
    onSuccess: (next) => queryClient.setQueryData(publicVoiceQueryKeys.squad(squadId), next),
  })
  const preview = useMutation({
    mutationFn: () =>
      previewSquadVoice(squadId, {
        surface: previewSurface,
        ...(sample.trim() ? { sample } : {}),
        draft: { base: picker === CUSTOM ? customBase.trim() || null : null, surfaces },
        ...(picker !== CUSTOM ? { voiceId: picker === INSTANCE ? DEFAULT_PUBLIC_VOICE_ID : picker } : {}),
      }),
  })
  const saveProfile = useMutation({
    mutationFn: (input: { id: string; name: string; base: string; surfaces: PublicVoiceSurfaces }) => createPublicVoice(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: publicVoiceQueryKeys.all }),
  })

  const bytes = draftBytes(state, picker, customBase, surfaces)
  const overCap = bytes !== null && bytes > PUBLIC_VOICE_MAX_BYTES
  const pickedProfile =
    picker === CUSTOM ? null : (picker === INSTANCE ? DEFAULT_PUBLIC_VOICE_ID : picker) === state.profile?.id ? state.profile : null
  const saveError = save.error instanceof ApiError ? save.error.message : save.error ? String(save.error) : null

  return (
    <div className="space-y-6">
      <div>
        <h3 data-setting-target="public-voice" className="text-sm font-medium text-primary">
          Public voice
        </h3>
        <p className="mt-1 text-xs text-muted">
          How this squad's agents write commit messages, pull requests, review replies, issue comments and channel
          messages. The fixed rules (speak as Ficus, no internals, no secrets, never call a skipped check passed) always
          apply and cannot be changed here.
        </p>
      </div>

      {state.fallback && (
        <p className="text-xs text-status-attention-600">
          The assigned profile {state.voiceId} is {state.fallback === 'assigned_disabled' ? 'disabled' : 'missing'}; this
          squad uses the instance default until you pick another.
        </p>
      )}
      {state.resolved.overCap && (
        <p className="text-xs text-status-attention-600">
          The voice is over the {PUBLIC_VOICE_MAX_BYTES.toLocaleString()}-byte cap, so agents get it without these
          surface entries: {state.resolved.dropped.map((s) => PUBLIC_SURFACE_LABELS[s]).join(', ')}.
        </p>
      )}

      {!canEdit ? (
        <div>
          <p className="text-xs text-muted">The voice agents in this squad receive:</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-surface-secondary p-3 text-xs text-primary">
            {state.resolved.rendered || 'No voice: only the fixed rules apply.'}
          </pre>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <label className="text-xs text-muted" htmlFor="squad-voice-picker">
              Voice
            </label>
            <select
              id="squad-voice-picker"
              className="ficus-field block w-full rounded-md border border-th-border bg-surface px-2 py-1.5 text-sm text-primary"
              value={picker}
              onChange={(e) => setPicker(e.target.value)}
            >
              <option value={INSTANCE}>Instance default</option>
              {state.availableVoices
                .filter((v) => v.id !== DEFAULT_PUBLIC_VOICE_ID)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              <option value={CUSTOM}>Custom for this squad</option>
            </select>
            {picker === CUSTOM ? (
              <textarea
                aria-label="Custom voice"
                value={customBase}
                onChange={(e) => setCustomBase(e.target.value)}
                placeholder="How should this squad's agents write? For example: lead with the result, short sentences, no headings in chat."
                className="ficus-field h-40 w-full rounded-md border border-th-border bg-surface p-2 text-sm text-primary"
              />
            ) : pickedProfile ? (
              <p className="whitespace-pre-wrap rounded-md bg-surface-secondary p-2 text-xs text-secondary">{pickedProfile.base}</p>
            ) : (
              <p className="text-xs text-muted">
                {state.availableVoices.find((v) => v.id === picker)?.description ?? 'Save to apply this profile.'}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-primary">Per surface</h4>
            <VoiceSurfaceRows
              value={surfaces}
              onChange={setSurfaces}
              inherited={picker === CUSTOM ? undefined : pickedProfile?.surfaces}
              inheritLabel={picker === CUSTOM ? 'None' : 'Inherit'}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={clsx('text-xs', overCap ? 'text-status-danger-500' : 'text-muted')} data-voice-meter="true">
              {bytes === null
                ? `Size is checked against the ${PUBLIC_VOICE_MAX_BYTES.toLocaleString()}-byte cap when you save`
                : `${bytes.toLocaleString()} / ${PUBLIC_VOICE_MAX_BYTES.toLocaleString()} bytes`}
            </span>
            <button
              className="ficus-button ficus-button-primary rounded-md px-4 py-1.5 text-sm"
              disabled={save.isPending || overCap || (picker === CUSTOM && !customBase.trim())}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {saveError && <p className="text-xs text-status-danger-500">{saveError}</p>}

          <div className="space-y-2 rounded-xl border border-panel-border bg-surface p-4">
            <h4 className="text-sm font-medium text-primary">Preview</h4>
            <p className="text-xs text-muted">Rewrites a sample comment in the voice above, including unsaved edits.</p>
            <select
              aria-label="Preview surface"
              className="ficus-field rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
              value={previewSurface}
              onChange={(e) => setPreviewSurface(e.target.value as PublicSurface)}
            >
              {PUBLIC_SURFACES.map((s) => (
                <option key={s} value={s}>
                  {PUBLIC_SURFACE_LABELS[s]}
                </option>
              ))}
            </select>
            <textarea
              aria-label="Sample text"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder="Leave empty to use a built-in sample pull request comment."
              className="ficus-field h-24 w-full rounded-md border border-th-border bg-surface p-2 text-sm text-primary"
            />
            <button
              className="ficus-button ficus-button-ghost rounded-md px-3 py-1 text-sm"
              disabled={preview.isPending}
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? 'Rewriting…' : 'Preview'}
            </button>
            {preview.data && (
              <pre className="whitespace-pre-wrap rounded-md bg-surface-secondary p-2 text-sm text-primary">{preview.data.text}</pre>
            )}
            {preview.error && <p className="text-xs text-status-danger-500">The preview is unavailable right now.</p>}
          </div>

          <DeriveVoiceCard
            squadId={squadId}
            linkedLogin={state.linkedGitHubLogin}
            useDraftLabel="Use as this squad's custom voice"
            onUseDraft={(draft) => {
              setPicker(CUSTOM)
              setCustomBase(draft.base)
              setSurfaces(draft.surfaces)
            }}
            onSaveAsProfile={
              canManageProfiles
                ? (draft) => {
                    const id = window.prompt('New profile id (kebab-case)')
                    if (!id) return
                    const name = window.prompt('Profile name', id) ?? id
                    saveProfile.mutate({ id, name, base: draft.base, surfaces: draft.surfaces })
                  }
                : undefined
            }
          />
          {saveProfile.isSuccess && <p className="text-xs text-muted">Saved as a new profile. Edit it in Settings → Agent Types → Voices.</p>}
          {saveProfile.error && <p className="text-xs text-status-danger-500">{String(saveProfile.error)}</p>}
        </>
      )}
    </div>
  )
}
