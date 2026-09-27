import type { WorkflowSource } from '@ficus/shared'
import { WorkflowPicker } from './WorkflowPicker'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../Modal'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { createSquad, fileToAvatarImage, uploadSquadAvatar } from '../../api/squads'
import { SquadAvatar } from './SquadAvatar'
import { CreateHostWorkspaceField } from './CreateHostWorkspaceField'
import { createHostWorkspacePathError } from './createHostWorkspacePath'

interface Props {
  isOpen: boolean
  onClose: () => void
}

export function CreateSquadModal({ isOpen, onClose }: Props) {
  const navigate = useNavigate()
  const { slugFor } = useSquadSlugs()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [context, setContext] = useState('')
  const [squadPresetId, setSquadPresetId] = useState('')
  const [workflow, setWorkflow] = useState<WorkflowSource>({ kind: 'preset', id: 'solo', customizations: [] })
  const [hostWorkspacePath, setHostWorkspacePath] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  useEffect(
    () => () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview)
    },
    [avatarPreview]
  )

  const { data: squadPresets, isLoading: squadPresetsLoading } = useQuery(queries.squadPresets.list())
  const { data: createOptions } = useQuery({ ...queries.squads.createOptions(), enabled: isOpen })

  const selectedType = useMemo(
    () => squadPresets?.find((t) => t.id === squadPresetId && !t.disabled),
    [squadPresets, squadPresetId]
  )

  function handleTypeChange(typeId: string) {
    setSquadPresetId(typeId)
    const type = squadPresets?.find((t) => t.id === typeId)
    setWorkflow(type?.workflows?.default ?? { kind: 'preset', id: 'solo', customizations: [] })
    if (type) {
      // Pre-fill purpose from squad preset if purpose is empty
      if (!purpose.trim() && type.purpose) {
        setPurpose(type.purpose)
      }
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const squad = await createSquad({
        name,
        purpose,
        context: context.trim() || undefined,
        squadPresetId: squadPresetId || undefined,
        defaultAgents: selectedType?.defaultAgents,
        ...(workflow ? { metadata: { workflow } } : {}),
        hostWorkspacePath: hostWorkspacePath.trim() || undefined,
      })
      // Squad created — upload the avatar if one was picked (non-fatal if it fails).
      if (avatarFile) {
        try {
          await uploadSquadAvatar(squad.id, await fileToAvatarImage(avatarFile))
        } catch {
          // ignore — the squad exists; the avatar can be set later in settings
        }
      }
      return squad
    },
    onSuccess: (squad) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
      setName('')
      setPurpose('')
      setContext('')
      setSquadPresetId('')
      setWorkflow({ kind: 'preset', id: 'solo', customizations: [] })
      setHostWorkspacePath('')
      setAvatarFile(null)
      setAvatarPreview(null)
      onClose()
      navigate(`/squads/${slugFor(squad.id)}`)
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || createHostWorkspacePathError(hostWorkspacePath.trim())) return
    mutation.mutate()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Squad">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="squad-name" className="block text-sm font-medium text-primary mb-1">
            Name
          </label>
          <input
            id="squad-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Frontend Team"
            className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-primary mb-1">Avatar (optional)</label>
          <div className="flex items-center gap-3">
            <SquadAvatar name={name || 'Squad'} avatarUrl={avatarPreview} size={56} />
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="ficus-button px-3 py-1.5 text-sm rounded-md font-medium bg-surface-secondary text-secondary border border-th-border hover:bg-surface-hover"
              >
                {avatarPreview ? 'Change image' : 'Choose image'}
              </button>
              <p className="text-xs text-muted mt-1">Shown as a circle — non-square images are cropped.</p>
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                if (avatarPreview) URL.revokeObjectURL(avatarPreview)
                setAvatarFile(file)
                setAvatarPreview(URL.createObjectURL(file))
              }}
            />
          </div>
        </div>

        <div>
          <label htmlFor="squad-purpose" className="block text-sm font-medium text-primary mb-1">
            Purpose (optional)
          </label>
          <textarea
            id="squad-purpose"
            aria-describedby="squad-purpose-help"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Software development for the company"
            rows={3}
            className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
          />
          <p id="squad-purpose-help" className="mt-1 text-xs text-muted">
            Strongly encouraged: describe what this squad is responsible for. The assistant and other agents use its
            purpose to help route work to the right squad.
          </p>
        </div>

        <div>
          <label htmlFor="squad-context" className="block text-sm font-medium text-primary mb-1">
            Context (optional)
          </label>
          <textarea
            id="squad-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Additional information to include in all squad agents' system prompts..."
            rows={6}
            className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
          />
        </div>

        <div>
          <label htmlFor="squad-preset" className="block text-sm font-medium text-primary mb-1">
            Preset
          </label>
          <select
            id="squad-preset"
            value={squadPresetId}
            onChange={(e) => handleTypeChange(e.target.value)}
            disabled={squadPresetsLoading}
            aria-busy={squadPresetsLoading || undefined}
            className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
          >
            <option value="">Build your own squad</option>
            {squadPresets
              ?.filter((type) => !type.disabled)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </select>
          {selectedType?.description && <p className="mt-1 text-xs text-secondary">{selectedType.description}</p>}
          {selectedType?.workflows?.choices.length ? (
            <p className="mt-1 text-xs text-secondary">
              Includes {selectedType.workflows.choices.length} recommended workflows for the manager to choose from.
            </p>
          ) : null}
        </div>

        {selectedType && selectedType.defaultAgents.length > 0 && (
          <div className="rounded-md bg-surface-hover px-3 py-2">
            <p className="text-xs font-medium text-secondary mb-1">Default Agents</p>
            <div className="flex flex-wrap gap-1">
              {selectedType.defaultAgents.map((agentType) => (
                <span
                  key={agentType}
                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent-light"
                >
                  {agentType}
                </span>
              ))}
            </div>
          </div>
        )}

        <WorkflowPicker value={workflow} onChange={setWorkflow} />

        {createOptions?.runtime === 'host' && createOptions.defaultHostWorkspaceRoot && (
          <CreateHostWorkspaceField
            id="squad-host-workspace-path"
            value={hostWorkspacePath}
            onChange={setHostWorkspacePath}
            defaultRoot={createOptions.defaultHostWorkspaceRoot}
          />
        )}

        {mutation.isError && (
          <p className="text-sm text-status-danger-600 dark:text-status-danger-400">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to create squad'}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="ficus-button px-4 py-2 text-sm font-medium text-secondary border border-th-border rounded-md hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              mutation.isPending || !name.trim() || createHostWorkspacePathError(hostWorkspacePath.trim()) !== null
            }
            className="ficus-button ficus-button-primary px-4 py-2 text-sm font-medium text-on-accent bg-accent rounded-md hover:bg-accent-hover disabled:opacity-50"
          >
            {mutation.isPending ? 'Creating...' : 'Create Squad'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
