import { useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceBytes,
  renderProfileAlone,
  type PublicVoiceProfileJson,
  type PublicVoiceSurfaces,
} from '@ficus/shared'
import {
  createPublicVoice,
  deletePublicVoice,
  publicVoiceQueryKeys,
  revertPublicVoice,
  setPublicVoiceDisabled,
  updatePublicVoice,
} from '../../api/publicVoices'
import { ApiError } from '../../api/client'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { VoiceSurfaceRows } from '../voice/VoiceSurfaceRows'
import { DeriveVoiceCard } from '../voice/DeriveVoiceCard'
import { NewProfileDialog } from '../voice/NewProfileDialog'
import { VoicePicker } from '../voice/VoicePicker'
import { ConfirmButton } from '../ConfirmButton'

interface ProfileDraft {
  name: string
  description: string
  base: string
  surfaces: PublicVoiceSurfaces
}

function draftOf(profile: Pick<PublicVoiceProfileJson, 'name' | 'description' | 'base' | 'surfaces'>): ProfileDraft {
  return { name: profile.name, description: profile.description ?? '', base: profile.base, surfaces: profile.surfaces }
}

function draftBytes(id: string, draft: ProfileDraft): number {
  return publicVoiceBytes(
    renderProfileAlone({
      id,
      name: draft.name,
      description: null,
      base: draft.base,
      surfaces: draft.surfaces,
      disabled: false,
    })
  )
}

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : error ? String(error) : null)

/** Pure list of profile cards; the tab adds editing. Testable without a query client. */
export function VoiceProfileList({
  profiles,
  canWrite,
  onEdit,
  onToggle,
  onDelete,
}: {
  profiles: PublicVoiceProfileJson[]
  canWrite: boolean
  onEdit: (profile: PublicVoiceProfileJson) => void
  onToggle: (profile: PublicVoiceProfileJson) => void
  onDelete: (profile: PublicVoiceProfileJson) => void
}) {
  if (!profiles.length) return <p className="py-8 text-center text-muted">No voice profiles.</p>
  return (
    <div className="space-y-3">
      {profiles.map((profile) => (
        <article
          key={profile.id}
          data-voice-profile={profile.id}
          className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border border-panel-border bg-surface p-4 sm:flex-row sm:items-start"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-semibold text-primary">
              <span>{profile.name}</span>
              {profile.id === DEFAULT_PUBLIC_VOICE_ID && (
                <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-muted">
                  Instance default
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
            <p className="mt-1 text-xs text-muted">
              {profile.bytes.toLocaleString()} / {PUBLIC_VOICE_MAX_BYTES.toLocaleString()} bytes ·{' '}
              {profile.assignedSquadCount ?? 0} assigned {profile.assignedSquadCount === 1 ? 'squad' : 'squads'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button className="ficus-button ficus-button-ghost px-2 py-1 text-sm" onClick={() => onEdit(profile)}>
              {canWrite ? 'Edit' : 'View'}
            </button>
            {canWrite && (
              <button className="ficus-button ficus-button-ghost px-2 py-1 text-sm" onClick={() => onToggle(profile)}>
                {profile.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
            {canWrite && profile.id !== DEFAULT_PUBLIC_VOICE_ID && !profile.hasTemplate && (
              <ConfirmButton
                label="Delete"
                confirmLabel={`Delete? ${profile.assignedSquadCount ?? 0} squad(s) return to the default`}
                ariaLabel={`Delete ${profile.name}`}
                className="px-2 py-1 text-sm"
                onConfirm={() => onDelete(profile)}
              />
            )}
          </div>
        </article>
      ))}
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
      <input
        aria-label="Profile name"
        disabled={!canWrite}
        className="ficus-field w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        aria-label="Profile description"
        disabled={!canWrite}
        placeholder="Short description"
        className="ficus-field w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <textarea
        aria-label="Voice"
        disabled={!canWrite}
        className="ficus-field h-40 w-full rounded-md border border-th-border bg-surface p-2 text-sm text-primary"
        value={draft.base}
        onChange={(e) => setDraft({ ...draft, base: e.target.value })}
      />
      <VoiceSurfaceRows
        value={draft.surfaces}
        onChange={(surfaces) => setDraft({ ...draft, surfaces })}
        inheritLabel="None"
        disabled={!canWrite}
      />
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
  const { data: profiles = [], isLoading } = useQuery(queries.publicVoices.list())
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), enabled: canWrite })
  const [editing, setEditing] = useState<{
    id: string
    initial: ProfileDraft
    isNew: boolean
    hasTemplate: boolean
  } | null>(null)
  const [deriveSquadId, setDeriveSquadId] = useState('')
  const invalidate = () => queryClient.invalidateQueries({ queryKey: publicVoiceQueryKeys.all })
  const toggle = useMutation({
    mutationFn: (profile: PublicVoiceProfileJson) => setPublicVoiceDisabled(profile.id, !profile.disabled),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (profile: PublicVoiceProfileJson) => deletePublicVoice(profile.id),
    onSuccess: invalidate,
  })

  // The id and name come from a dialog; the editor then opens with any derived draft prefilled.
  const [newProfileSeed, setNewProfileSeed] = useState<Partial<ProfileDraft> | null>(null)
  const startNew = (initial: Partial<ProfileDraft> = {}) => setNewProfileSeed(initial)

  if (isLoading) return <p className="text-sm text-muted">Loading voice profiles…</p>
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Voice profiles set how agents write public text: commits, pull requests, review replies, issue comments and
        channel messages. Squads use the instance default until they are assigned a profile in their Voice settings. The
        fixed public-text rules always apply on top.
      </p>
      {editing && (
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
      <VoiceProfileList
        profiles={profiles}
        canWrite={canWrite}
        onEdit={(profile) =>
          setEditing({ id: profile.id, initial: draftOf(profile), isNew: false, hasTemplate: profile.hasTemplate })
        }
        onToggle={(profile) => toggle.mutate(profile)}
        onDelete={(profile) => remove.mutate(profile)}
      />
      {remove.error && <p className="text-xs text-status-danger-500">{errorText(remove.error)}</p>}
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
          <button className="ficus-button ficus-button-primary rounded px-3 py-2" onClick={() => startNew()}>
            Add profile
          </button>
          <div className="space-y-2">
            <span className="block text-xs text-muted">Derive through the GitHub connection of</span>
            <VoicePicker
              label="Squad whose GitHub connection to use"
              value={deriveSquadId}
              onChange={setDeriveSquadId}
              options={[
                { value: '', label: 'Choose a squad' },
                ...squads.map((squad) => ({ value: squad.id, label: squad.name })),
              ]}
            />
            {deriveSquadId && (
              <DeriveVoiceCard
                key={deriveSquadId}
                squadId={deriveSquadId}
                linkedLogin={null}
                onSaveAsProfile={(draft) => startNew({ base: draft.base, surfaces: draft.surfaces })}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
