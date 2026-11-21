import { draftBytes, draftOf, type ProfileDraft } from '../voice/profileDraft'
import { SquadVoiceAssignments } from '../voice/SquadVoiceAssignments'
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_PUBLIC_VOICE_ID, PUBLIC_VOICE_MAX_BYTES, type PublicVoiceProfileJson } from '@ficus/shared'
import {
  createPublicVoice,
  deletePublicVoice,
  publicVoiceQueryKeys,
  revertPublicVoice,
  setPublicVoiceDisabled,
  setPublicVoiceInstanceDefault,
  updatePublicVoice,
} from '../../api/publicVoices'
import { ApiError } from '../../api/client'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { VoiceProfileDraftFields } from '../voice/VoiceProfileDraftFields'
import { AccountVoiceDerivation } from '../voice/AccountVoiceDerivation'
import { NewProfileDialog } from '../voice/NewProfileDialog'
import { ConfirmButton } from '../ConfirmButton'

/** Which profile is the instance default; servers without the field use the shipped `default`. */
function isInstanceDefaultProfile(profile: PublicVoiceProfileJson, profiles: PublicVoiceProfileJson[]): boolean {
  if (profiles.some((p) => p.isInstanceDefault !== undefined)) return Boolean(profile.isInstanceDefault)
  return profile.id === DEFAULT_PUBLIC_VOICE_ID
}

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : error ? String(error) : null)

/** Pure list of profile cards; the tab adds editing. Testable without a query client. */
export function VoiceProfileList({
  profiles,
  canWrite,
  onEdit,
  onToggle,
  onDelete,
  onSetDefault,
  assignments,
}: {
  assignments?: (profile: PublicVoiceProfileJson) => ReactNode
  profiles: PublicVoiceProfileJson[]
  canWrite: boolean
  onEdit: (profile: PublicVoiceProfileJson) => void
  onToggle: (profile: PublicVoiceProfileJson) => void
  onDelete: (profile: PublicVoiceProfileJson) => void
  /** Choose the profile as the instance default; omitted, the control is not shown. */
  onSetDefault?: (profile: PublicVoiceProfileJson) => void
}) {
  if (!profiles.length) return <p className="py-8 text-center text-muted">No voice profiles.</p>
  const chosenDefault = profiles.find((p) => isInstanceDefaultProfile(p, profiles))
  // The chosen default is disabled: squads on the instance default use the shipped profile.
  const shippedApplies = Boolean(chosenDefault?.disabled && chosenDefault.id !== DEFAULT_PUBLIC_VOICE_ID)
  return (
    <div className="space-y-3">
      {profiles.map((profile) => {
        const isDefault = isInstanceDefaultProfile(profile, profiles)
        const isShipped = profile.id === DEFAULT_PUBLIC_VOICE_ID
        return (
          <article
            key={profile.id}
            data-voice-profile={profile.id}
            className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border border-panel-border bg-surface p-4 sm:flex-row sm:items-start"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-semibold text-primary">
                <span>{profile.name}</span>
                {isDefault && (
                  <span
                    data-instance-default
                    className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent"
                  >
                    Default
                  </span>
                )}
                {isShipped && shippedApplies && (
                  <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-muted">
                    In use as the fallback default
                  </span>
                )}
                {profile.yamlFieldOverrides.length > 0 && (
                  <span className="rounded-full bg-status-attention-500/10 px-2 py-0.5 text-[11px] text-status-attention-600 dark:text-status-attention-400">
                    Modified from template
                  </span>
                )}
                {profile.disabled && (
                  <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-muted">Disabled</span>
                )}
              </div>
              <div className="font-mono text-xs text-muted">{profile.id}</div>
              {profile.description && <p className="mt-1 text-sm text-secondary">{profile.description}</p>}
              {isDefault && (
                <p className="mt-1 text-xs text-muted">
                  {profile.disabled && !isShipped
                    ? 'The instance default is disabled, so squads without an assignment use the shipped default profile until it is enabled again or another default is chosen.'
                    : profile.disabled
                      ? 'The instance default is disabled, so squads without an assignment get no voice; only the fixed rules apply.'
                      : 'Every squad without an assigned profile or its own voice uses this profile.'}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                {profile.bytes.toLocaleString()} / {PUBLIC_VOICE_MAX_BYTES.toLocaleString()} bytes ·{' '}
                {profile.assignedSquadCount ?? 0} assigned {profile.assignedSquadCount === 1 ? 'squad' : 'squads'}
              </p>
              {assignments?.(profile)}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <button className="ficus-button ficus-button-ghost px-2 py-1 text-sm" onClick={() => onEdit(profile)}>
                {canWrite ? 'Edit' : 'View'}
              </button>
              {canWrite && onSetDefault && !isDefault && !profile.disabled && (
                <button
                  className="ficus-button ficus-button-ghost px-2 py-1 text-sm"
                  aria-label={`Set ${profile.name} as default`}
                  onClick={() => onSetDefault(profile)}
                >
                  Set as default
                </button>
              )}
              {canWrite &&
                (isDefault && !profile.disabled ? (
                  // Disabling the default changes the voice of every unassigned squad: confirm first.
                  <ConfirmButton
                    label="Disable"
                    confirmLabel={
                      isShipped
                        ? 'Disable? Unassigned squads get no voice'
                        : 'Disable? Unassigned squads use the shipped default'
                    }
                    ariaLabel={`Disable ${profile.name}`}
                    variant="ghost"
                    className="px-2 py-1 text-sm"
                    onConfirm={() => onToggle(profile)}
                  />
                ) : (
                  <button
                    className="ficus-button ficus-button-ghost px-2 py-1 text-sm"
                    onClick={() => onToggle(profile)}
                  >
                    {profile.disabled ? 'Enable' : 'Disable'}
                  </button>
                ))}
              {canWrite && !isShipped && !profile.hasTemplate && (
                <ConfirmButton
                  label="Delete"
                  confirmLabel={
                    isDefault
                      ? `Delete the default? Unassigned squads and ${profile.assignedSquadCount ?? 0} assigned squad(s) return to the shipped default`
                      : `Delete? ${profile.assignedSquadCount ?? 0} squad(s) return to the default`
                  }
                  ariaLabel={`Delete ${profile.name}`}
                  className="px-2 py-1 text-sm"
                  onConfirm={() => onDelete(profile)}
                />
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

function ProfileEditor({
  id,
  initial,
  isNew,
  hasTemplate,
  canWrite,
  onClose,
}: {
  id: string
  initial: ProfileDraft
  isNew: boolean
  hasTemplate: boolean
  canWrite: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(initial)
  const [notice, setNotice] = useState('')
  const bytes = draftBytes(id, draft)
  const overCap = bytes > PUBLIC_VOICE_MAX_BYTES
  const invalidate = () => queryClient.invalidateQueries({ queryKey: publicVoiceQueryKeys.all })
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        base: draft.base,
        surfaces: draft.surfaces,
      }
      if (isNew) {
        await createPublicVoice({ id, ...body })
        return 0
      }
      return (await updatePublicVoice(id, body)).overCapSquadCount
    },
    onSuccess: (overCapSquadCount) => {
      void invalidate()
      setNotice(
        overCapSquadCount
          ? `Saved. ${overCapSquadCount} assigned squad(s) are now over the cap with their own entries; their last surface entries are dropped until they trim them.`
          : 'Saved.'
      )
      if (isNew) onClose()
    },
  })
  const revert = useMutation({
    mutationFn: () => revertPublicVoice(id),
    onSuccess: () => {
      void invalidate()
      onClose()
    },
  })

  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-surface p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-primary">{isNew ? `New profile ${id}` : `Edit ${id}`}</h4>
        <button className="ficus-button ficus-button-ghost px-2 py-1 text-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <VoiceProfileDraftFields draft={draft} setDraft={setDraft} disabled={!canWrite} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={clsx('text-xs', overCap ? 'text-status-danger-500' : 'text-muted')}>
          {bytes.toLocaleString()} / {PUBLIC_VOICE_MAX_BYTES.toLocaleString()} bytes
        </span>
        {canWrite && (
          <div className="flex gap-2">
            {hasTemplate && (
              <button
                className="ficus-button ficus-button-ghost rounded-md px-3 py-1 text-sm"
                onClick={() => revert.mutate()}
              >
                Revert to template
              </button>
            )}
            <button
              className="ficus-button ficus-button-primary rounded-md px-3 py-1 text-sm"
              disabled={overCap || !draft.base.trim() || !draft.name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
      {notice && <p className="text-xs text-muted">{notice}</p>}
      {(save.error || revert.error) && (
        <p className="text-xs text-status-danger-500">{errorText(save.error ?? revert.error)}</p>
      )}
    </div>
  )
}

/**
 * Settings → Voices: named voice profiles squads are assigned
 * to. `agent-types:read` sees them; `agent-types:update` manages them.
 */
export function VoicesTab() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canWrite = can('agent-types:update')
  const canRead = can('agent-types:read')
  const {
    data: profiles = [],
    isLoading,
    error: profilesError,
  } = useQuery({ ...queries.publicVoices.list(), enabled: canRead })
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), enabled: canRead })
  const [editing, setEditing] = useState<{
    id: string
    initial: ProfileDraft
    isNew: boolean
    hasTemplate: boolean
  } | null>(null)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: publicVoiceQueryKeys.all })
  const toggle = useMutation({
    mutationFn: (profile: PublicVoiceProfileJson) => setPublicVoiceDisabled(profile.id, !profile.disabled),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (profile: PublicVoiceProfileJson) => deletePublicVoice(profile.id),
    onSuccess: invalidate,
  })
  const [defaultNotice, setDefaultNotice] = useState('')
  const setDefault = useMutation({
    mutationFn: (profile: PublicVoiceProfileJson) => setPublicVoiceInstanceDefault(profile.id),
    onMutate: () => setDefaultNotice(''),
    onSuccess: (result) => {
      void invalidate()
      setDefaultNotice(
        `${result.name ?? result.voiceId} is now the default voice for every squad without an assignment.${
          result.overCapSquadCount
            ? ` ${result.overCapSquadCount} of those squad(s) are over the cap with their own entries; their last surface entries are dropped until they trim them.`
            : ''
        }`
      )
    },
  })

  // The id and name come from a dialog; the editor then opens with any derived draft prefilled.
  const [newProfileSeed, setNewProfileSeed] = useState<Partial<ProfileDraft> | null>(null)
  const startNew = (initial: Partial<ProfileDraft> = {}) => setNewProfileSeed(initial)

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Voice profiles set how agents write public text: commits, pull requests, review replies, issue comments and
        channel messages. Every squad uses the default profile until it is assigned another one or sets its own voice;
        use Set as default to choose which profile that is. The fixed public-text rules always apply on top.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-primary">Voice profiles</h4>
        {canWrite && (
          <button
            className="ficus-button ficus-button-primary min-h-11 rounded px-3 py-2 sm:min-h-0"
            onClick={() => startNew()}
          >
            Add profile
          </button>
        )}
      </div>
      {editing && (editing.isNew || canRead) && (
        <ProfileEditor
          key={editing.id}
          id={editing.id}
          initial={editing.initial}
          isNew={editing.isNew}
          hasTemplate={editing.hasTemplate}
          canWrite={canWrite}
          onClose={() => setEditing(null)}
        />
      )}
      {!canRead ? (
        <p className="text-sm text-muted">Profile listing requires permission to read voice profiles.</p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading voice profiles…</p>
      ) : profilesError ? (
        <p role="alert" className="text-sm text-status-danger-500">
          Could not load voice profiles.
        </p>
      ) : (
        <VoiceProfileList
          profiles={profiles}
          assignments={(profile) => <SquadVoiceAssignments key={profile.id} profile={profile} squads={squads} />}
          canWrite={canWrite}
          onEdit={(profile) =>
            setEditing({ id: profile.id, initial: draftOf(profile), isNew: false, hasTemplate: profile.hasTemplate })
          }
          onToggle={(profile) => toggle.mutate(profile)}
          onDelete={(profile) => remove.mutate(profile)}
          onSetDefault={(profile) => setDefault.mutate(profile)}
        />
      )}
      {defaultNotice && (
        <p role="status" className="text-xs text-muted">
          {defaultNotice}
        </p>
      )}
      {(remove.error || setDefault.error) && (
        <p className="text-xs text-status-danger-500">{errorText(remove.error ?? setDefault.error)}</p>
      )}
      <NewProfileDialog
        isOpen={newProfileSeed !== null}
        onClose={() => setNewProfileSeed(null)}
        onSubmit={({ id, name }) => {
          setEditing({
            id,
            isNew: true,
            hasTemplate: false,
            initial: { description: '', base: '', surfaces: {}, ...newProfileSeed, name },
          })
          setNewProfileSeed(null)
        }}
      />
      {canWrite && (
        <>
          <h4 className="border-t border-th-border pt-5 text-sm font-medium text-primary">
            Create a voice from GitHub
          </h4>
          <AccountVoiceDerivation
            onTargetChange={() => {
              setNewProfileSeed(null)
              setEditing((current) => (current?.isNew ? null : current))
            }}
            onSaveAsProfile={(draft) => startNew({ base: draft.base, surfaces: draft.surfaces })}
          />
        </>
      )}
    </div>
  )
}
