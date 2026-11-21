import { useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_SURFACES,
  PUBLIC_SURFACE_LABELS,
  PUBLIC_VOICE_MAX_BYTES,
  type PublicSurface,
  type PublicVoiceSurfaces,
  type SquadPublicVoiceState,
} from '@ficus/shared'
import { createPublicVoice, patchSquadVoice, previewSquadVoice, publicVoiceQueryKeys } from '../../api/publicVoices'
import { ApiError } from '../../api/client'
import { usePermissions } from '../../hooks/usePermissions'
import { useAdjustOnChange } from '../../hooks/useAdjustOnChange'
import { VoiceSurfaceRows } from '../voice/VoiceSurfaceRows'
import { DeriveVoiceCard } from '../voice/DeriveVoiceCard'
import { NewProfileDialog } from '../voice/NewProfileDialog'
import { VoicePicker } from '../voice/VoicePicker'
import { queries } from '../../queryOptions'
import {
  buildVoicePatch,
  CUSTOM,
  draftBytes,
  INSTANCE,
  instanceDefaultVoiceId,
  pickerValueFor,
} from './squadVoiceDraft'

/** Squad settings → Voice: how this squad's agents sound in public text. See docs/wiki/public-voice.md. */
export function SquadVoiceSettings({ squadId }: { squadId: string }) {
  const { data: state, error } = useQuery(queries.publicVoices.squad(squadId))
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
  const [pendingProfileDraft, setPendingProfileDraft] = useState<{
    base: string
    surfaces: PublicVoiceSurfaces
  } | null>(null)

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
        // null previews the instance default, which works even while the `default` profile is disabled.
        ...(picker !== CUSTOM ? { voiceId: picker === INSTANCE ? null : picker } : {}),
      }),
  })
  const saveProfile = useMutation({
    mutationFn: (input: { id: string; name: string; base: string; surfaces: PublicVoiceSurfaces }) =>
      createPublicVoice(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: publicVoiceQueryKeys.all }),
  })

  const bytes = draftBytes(state, picker, customBase, surfaces)
  const overCap = bytes !== null && bytes > PUBLIC_VOICE_MAX_BYTES
  const pickedProfile =
    picker === CUSTOM
      ? null
      : (picker === INSTANCE ? instanceDefaultVoiceId(state) : picker) === state.profile?.id
        ? state.profile
        : null
  const instanceName = state.instanceDefault?.effectiveName
  const instanceDefaultLabel = instanceName ? `Instance default (${instanceName})` : 'Instance default'
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

      {(state.fallback === 'assigned_disabled' || state.fallback === 'assigned_missing') && (
        <p className="text-xs text-status-attention-600">
          The assigned profile {state.voiceId} is {state.fallback === 'assigned_disabled' ? 'disabled' : 'missing'};
          this squad uses the instance default until you pick another.
        </p>
      )}
      {(state.fallback === 'default_disabled' || state.fallback === 'default_missing') && (
        <p className="text-xs text-status-attention-600">
          The instance default profile {state.instanceDefault?.name ?? state.instanceDefault?.voiceId} is{' '}
          {state.fallback === 'default_disabled' ? 'disabled' : 'missing'}; this squad uses the shipped default profile
          instead.
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
            <span className="block text-xs text-muted">Voice</span>
            <VoicePicker
              label="Voice"
              value={picker}
              onChange={setPicker}
              className="w-full"
              options={[
                {
                  value: INSTANCE,
                  label: instanceDefaultLabel,
                  description: 'Follows the instance default when an admin changes it',
                },
                ...state.availableVoices
                  // The shipped profile is listed on its own only when another profile is the default.
                  .filter((v) => v.id !== DEFAULT_PUBLIC_VOICE_ID || instanceDefaultVoiceId(state) !== v.id)
                  .map((v) => ({ value: v.id, label: v.name, description: v.description ?? undefined })),
                { value: CUSTOM, label: 'Custom for this squad' },
              ]}
            />
            {picker === CUSTOM ? (
              <textarea
                aria-label="Custom voice"
                value={customBase}
                onChange={(e) => setCustomBase(e.target.value)}
                placeholder="How should this squad's agents write? For example: lead with the result, short sentences, no headings in chat."
                className="ficus-field h-40 w-full rounded-md border border-th-border bg-surface p-2 text-sm text-primary"
              />
            ) : pickedProfile ? (
              <p className="whitespace-pre-wrap rounded-md bg-surface-secondary p-2 text-xs text-secondary">
                {pickedProfile.base}
              </p>
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
            <span
              className={clsx('text-xs', overCap ? 'text-status-danger-500' : 'text-muted')}
              data-voice-meter="true"
            >
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
            <VoicePicker
              label="Preview surface"
              value={previewSurface}
              onChange={setPreviewSurface}
              options={PUBLIC_SURFACES.map((s) => ({ value: s, label: PUBLIC_SURFACE_LABELS[s] }))}
            />
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
              <pre className="whitespace-pre-wrap rounded-md bg-surface-secondary p-2 text-sm text-primary">
                {preview.data.text}
              </pre>
            )}
            {preview.error && <p className="text-xs text-status-danger-500">The preview is unavailable right now.</p>}
          </div>

          <div data-setting-target="derive-voice">
            <DeriveVoiceCard
              target={{ kind: 'squad', squadId }}
              linkedLogin={state.linkedGitHubLogin}
              useDraftLabel="Use as this squad's custom voice"
              onUseDraft={(draft) => {
                setPicker(CUSTOM)
                setCustomBase(draft.base)
                setSurfaces(draft.surfaces)
              }}
              onSaveAsProfile={canManageProfiles ? (draft) => setPendingProfileDraft(draft) : undefined}
            />
          </div>
          {saveProfile.isSuccess && (
            <p className="text-xs text-muted">Saved as a new profile. Edit it in Settings → Voices.</p>
          )}
          <NewProfileDialog
            isOpen={pendingProfileDraft !== null}
            onClose={() => setPendingProfileDraft(null)}
            pending={saveProfile.isPending}
            error={saveProfile.error ? String(saveProfile.error) : null}
            onSubmit={({ id, name }) =>
              pendingProfileDraft &&
              saveProfile.mutate(
                { id, name, base: pendingProfileDraft.base, surfaces: pendingProfileDraft.surfaces },
                { onSuccess: () => setPendingProfileDraft(null) }
              )
            }
          />
        </>
      )}
    </div>
  )
}
