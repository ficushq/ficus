import { CatalogSearch } from './CatalogSearch'
import { SquadPresetWorkflowsEditor } from './SquadPresetWorkflowsEditor'
import type { SquadPresetWorkflows } from '@ficus/shared'
import { Modal } from '../Modal'
import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  type SquadPresetConfig,
  createSquadPreset,
  updateSquadPreset,
  deleteSquadPreset,
  revertSquadPreset,
  revertSquadPresetFields,
  disableSquadPreset,
  enableSquadPreset,
  exportSquadPresetYaml,
} from '../../api/config'
import { TemplateDiffDialog } from './TemplateDiffDialog'
import { TemplateFieldActions } from './TemplateFieldActions'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

export function SquadPresetsSection() {
  const queryClient = useQueryClient()
  const { data: squadPresets = [], isLoading } = useQuery(queries.squadPresets.list())
  const loadingCardCount = useLoadingShapeCount('settings:squad-presets', isLoading ? undefined : squadPresets.length, {
    fallbackCount: 4,
    maxCount: 8,
  })
  const [search, setSearch] = useState('')
  const filteredTypes = [...squadPresets]
    .filter((type) =>
      `${type.name} ${type.id} ${type.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [diffId, setDiffId] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canCreateSquadPresets = !permissionsLoading && can('squad-presets:create')
  const canUpdateSquadPresets = !permissionsLoading && can('squad-presets:update')
  const canDeleteSquadPresets = !permissionsLoading && can('squad-presets:delete')

  const diffQuery = useQuery({
    ...queries.squadPresets.templateDiff(diffId ?? ''),
    enabled: !!diffId,
  })

  const revertMutation = useMutation({
    mutationFn: (id: string) => revertSquadPreset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
      setDiffId(null)
    },
  })

  const revertFieldsMutation = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: string[] }) => revertSquadPresetFields(id, fields),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
      if (diffId) queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.templateDiff(diffId) })
    },
  })

  if (isLoading) {
    return <CollectionSkeleton label="Loading squad presets" count={loadingCardCount} layout="cards" />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">Squad Presets</h3>
          <p className="text-sm text-muted mt-1">Define a squad’s purpose, starting agents, and shared instructions.</p>
        </div>
        {canCreateSquadPresets && (
          <button
            onClick={() => setIsAdding(true)}
            disabled={isAdding}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm bg-accent text-on-accent rounded-md hover:bg-accent/90 disabled:opacity-50 shrink-0"
          >
            New squad preset
          </button>
        )}
      </div>

      {canCreateSquadPresets && isAdding && (
        <Modal isOpen onClose={() => setIsAdding(false)} title="New squad preset" maxWidth="wide">
          <AddSquadPresetForm
            onClose={() => setIsAdding(false)}
            onCreated={() => {
              setIsAdding(false)
            }}
          />
        </Modal>
      )}

      <CatalogSearch
        label="Search squad presets"
        placeholder="Find a squad preset…"
        value={search}
        onChange={setSearch}
      />
      <div>
        <div className="space-y-3">
          {filteredTypes.length === 0 ? (
            <div className="px-4 py-8 text-center text-muted">
              {search ? 'No squad presets match your search.' : 'No squad presets configured.'}
            </div>
          ) : (
            filteredTypes.map((st) => (
              <SquadPresetRow
                key={st.id}
                squadPreset={st}
                isExpanded={expandedId === st.id}
                onToggle={() => setExpandedId(expandedId === st.id ? null : st.id)}
                onShowDiff={() => setDiffId(st.id)}
                canUpdate={canUpdateSquadPresets}
                canDelete={canDeleteSquadPresets}
              />
            ))
          )}
        </div>
      </div>

      <TemplateDiffDialog
        isOpen={!!diffId}
        onClose={() => setDiffId(null)}
        title={`Template Diff — ${diffId}`}
        current={diffQuery.data?.current ?? null}
        template={diffQuery.data?.template ?? null}
        onRevert={() => canUpdateSquadPresets && diffId && revertMutation.mutate(diffId)}
        onRevertFields={(fields) =>
          canUpdateSquadPresets && diffId && revertFieldsMutation.mutate({ id: diffId, fields })
        }
        fieldOverrides={diffQuery.data?.fieldOverrides ?? []}
        isReverting={revertMutation.isPending || revertFieldsMutation.isPending}
      />
    </div>
  )
}

// ============================================================================
// Add / Edit forms
// ============================================================================

function AddSquadPresetForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const queryClient = useQueryClient()
  const [newId, setNewId] = useState('')
  const [form, setForm] = useState({
    name: '',
    description: '',
    purpose: '',
    defaultAgents: '',
    managerInstructions: '',
    scheduleTemplates: '',
    workflows: null as SquadPresetWorkflows | null,
  })

  const createMutation = useMutation({
    mutationFn: (data: Partial<SquadPresetConfig> & { id: string }) => createSquadPreset(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
      onCreated()
    },
  })

  const handleCreate = () => {
    const id = newId.trim()
    if (!id) {
      alert('ID is required')
      return
    }
    if (!form.name.trim()) {
      alert('Name is required')
      return
    }

    let scheduleTemplates: unknown[] = []
    try {
      scheduleTemplates = form.scheduleTemplates.trim() ? JSON.parse(form.scheduleTemplates) : []
    } catch {
      alert('Invalid JSON in Schedule Templates')
      return
    }

    createMutation.mutate({
      id,
      name: form.name,
      description: form.description || null,
      purpose: form.purpose || null,
      defaultAgents: csvToArray(form.defaultAgents) ?? [],
      managerInstructions: form.managerInstructions || null,
      scheduleTemplates,
      workflows: form.workflows,
    })
  }

  return (
    <div
      className="space-y-5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <FormField label="ID (unique key)" value={newId} onChange={setNewId} placeholder="e.g. my-squad-preset" />
      <FormField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
      <FormField label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
      <FormField label="Purpose" value={form.purpose} onChange={(v) => setForm({ ...form, purpose: v })} />
      <FormField
        label="Default Agents (comma-separated)"
        value={form.defaultAgents}
        onChange={(v) => setForm({ ...form, defaultAgents: v })}
      />
      <FormField
        label="Manager Instructions"
        value={form.managerInstructions}
        onChange={(v) => setForm({ ...form, managerInstructions: v })}
        textarea
        rows={4}
      />
      <p className="text-xs text-muted">
        Copied into the new squad’s manager context. You can edit it in Squad Settings → Context afterward.
      </p>
      <SquadPresetWorkflowsEditor value={form.workflows} onChange={(workflows) => setForm({ ...form, workflows })} />
      <FormField
        label="Schedule Templates (JSON)"
        value={form.scheduleTemplates}
        onChange={(v) => setForm({ ...form, scheduleTemplates: v })}
        textarea
        rows={3}
      />
      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={handleCreate}
          disabled={createMutation.isPending}
          className="ficus-button ficus-button-primary text-sm bg-accent text-on-accent px-4 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating…' : 'Create'}
        </button>
        <button onClick={onClose} className="ficus-button ficus-button-secondary text-sm px-3 py-1.5">
          Cancel
        </button>
        {createMutation.isError && (
          <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
            {(createMutation.error as Error).message}
          </span>
        )}
      </div>
    </div>
  )
}

function SquadPresetRow({
  squadPreset,
  isExpanded,
  onToggle,
  onShowDiff,
  canUpdate,
  canDelete,
}: {
  squadPreset: SquadPresetConfig
  isExpanded: boolean
  onToggle: () => void
  onShowDiff: () => void
  canUpdate: boolean
  canDelete: boolean
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(() => squadPresetToForm(squadPreset))
  const [copyMsg, setCopyMsg] = useState('')

  useEffect(() => {
    setForm(squadPresetToForm(squadPreset))
  }, [squadPreset])

  const updateMutation = useMutation({
    mutationFn: (data: Partial<SquadPresetConfig>) => updateSquadPreset(squadPreset.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteSquadPreset(squadPreset.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
    },
  })

  const toggleDisableMutation = useMutation({
    mutationFn: () => (squadPreset.disabled ? enableSquadPreset(squadPreset.id) : disableSquadPreset(squadPreset.id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
    },
  })

  const fieldDiffQuery = useQuery({
    ...queries.squadPresets.templateDiff(squadPreset.id),
    enabled: isExpanded && squadPreset.hasTemplate,
  })

  const revertFieldMutation = useMutation({
    mutationFn: (field: string) => revertSquadPresetFields(squadPreset.id, [field]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.squadPresets.templateDiff(squadPreset.id) })
    },
  })

  const fieldActions = (field: string) => (
    <TemplateFieldActions
      field={field}
      current={fieldDiffQuery.data?.current ?? null}
      template={fieldDiffQuery.data?.template ?? null}
      fieldOverrides={fieldDiffQuery.data?.fieldOverrides ?? squadPreset.yamlFieldOverrides}
      onRevert={(field) => canUpdate && revertFieldMutation.mutate(field)}
      isReverting={revertFieldMutation.isPending}
    />
  )

  const handleSave = () => {
    let scheduleTemplates: unknown[] = []
    try {
      scheduleTemplates = form.scheduleTemplates.trim() ? JSON.parse(form.scheduleTemplates) : []
    } catch {
      alert('Invalid JSON in Schedule Templates')
      return
    }

    updateMutation.mutate({
      name: form.name,
      description: form.description || null,
      purpose: form.purpose || null,
      defaultAgents: csvToArray(form.defaultAgents) ?? [],
      managerInstructions: form.managerInstructions || null,
      scheduleTemplates,
      workflows: form.workflows,
    })
  }

  const handleExport = async () => {
    try {
      const yaml = await exportSquadPresetYaml(squadPreset.id)
      await navigator.clipboard.writeText(yaml)
      setCopyMsg('Copied!')
      setTimeout(() => setCopyMsg(''), 2000)
    } catch {
      setCopyMsg('Failed')
      setTimeout(() => setCopyMsg(''), 2000)
    }
  }

  const handleDelete = () => {
    if (window.confirm(`Delete squad preset "${squadPreset.name}"? This cannot be undone.`)) {
      deleteMutation.mutate()
    }
  }

  return (
    <article className="min-w-0 rounded-xl border border-panel-border bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-primary">{squadPreset.name}</span>
            <span className="text-xs text-muted font-mono">{squadPreset.id}</span>
            {squadPreset.disabled && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-600 dark:text-status-neutral-400">
                Disabled
              </span>
            )}
            {squadPreset.yamlFieldOverrides.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-review-100 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-400">
                Modified
              </span>
            )}
            {!squadPreset.hasTemplate && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent-light">Custom</span>
            )}
          </div>
          <p className="text-sm text-secondary mt-2">{squadPreset.description || 'No description'}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${canUpdate ? 'Edit' : 'View'} ${squadPreset.name}`}
          className="ficus-button shrink-0 text-sm text-accent-light"
        >
          {canUpdate ? 'Edit' : 'View'}
        </button>
      </div>

      {isExpanded && (
        <Modal isOpen onClose={onToggle} title={`${canUpdate ? 'Edit' : 'View'} ${squadPreset.name}`} maxWidth="wide">
          <div
            className="space-y-5"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                onToggle()
              }
            }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              {squadPreset.hasTemplate && squadPreset.yamlFieldOverrides.length > 0 && (
                <button
                  onClick={onShowDiff}
                  className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium"
                >
                  Compare to Template
                </button>
              )}
              <button
                onClick={handleExport}
                className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium"
              >
                {copyMsg || 'Export YAML'}
              </button>
              {canUpdate && (
                <button
                  onClick={() => toggleDisableMutation.mutate()}
                  disabled={toggleDisableMutation.isPending}
                  className="ficus-button text-xs text-status-attention-600 dark:text-status-attention-400 hover:text-status-attention-800 dark:hover:text-status-attention-300 font-medium"
                >
                  {squadPreset.disabled ? 'Enable' : 'Disable'}
                </button>
              )}
              {canDelete && !squadPreset.hasTemplate && (
                <button
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                  className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium"
                >
                  Delete
                </button>
              )}
            </div>

            <fieldset disabled={!canUpdate} className="space-y-5">
              <FormField
                label="Name"
                value={form.name}
                onChange={(v) => setForm({ ...form, name: v })}
                actions={fieldActions('name')}
              />
              <FormField
                label="Description"
                value={form.description}
                onChange={(v) => setForm({ ...form, description: v })}
                actions={fieldActions('description')}
              />
              <FormField
                label="Purpose"
                value={form.purpose}
                onChange={(v) => setForm({ ...form, purpose: v })}
                actions={fieldActions('purpose')}
              />
              <FormField
                label="Default Agents (comma-separated)"
                value={form.defaultAgents}
                onChange={(v) => setForm({ ...form, defaultAgents: v })}
                actions={fieldActions('defaultAgents')}
              />
              <FormField
                label="Manager Instructions"
                value={form.managerInstructions}
                onChange={(v) => setForm({ ...form, managerInstructions: v })}
                textarea
                rows={6}
                actions={fieldActions('managerInstructions')}
              />
              <p className="text-xs text-muted">
                Copied into the new squad’s manager context. Existing squads keep their own settings.
              </p>
              <SquadPresetWorkflowsEditor
                value={form.workflows}
                onChange={(workflows) => setForm({ ...form, workflows })}
                actions={fieldActions('workflows')}
              />
              <FormField
                label="Schedule Templates (JSON)"
                value={form.scheduleTemplates}
                onChange={(v) => setForm({ ...form, scheduleTemplates: v })}
                textarea
                rows={4}
                actions={fieldActions('scheduleTemplates')}
              />

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={!canUpdate || updateMutation.isPending}
                  className="ficus-button ficus-button-primary text-sm bg-accent text-on-accent px-4 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                {updateMutation.isSuccess && (
                  <span className="text-xs text-status-success-600 dark:text-status-success-400">Saved!</span>
                )}
                {updateMutation.isError && (
                  <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
                    {(updateMutation.error as Error).message}
                  </span>
                )}
              </div>
            </fieldset>
          </div>
        </Modal>
      )}
    </article>
  )
}

// ============================================================================
// Helpers
// ============================================================================

function FormField({
  label,
  value,
  onChange,
  textarea,
  rows,
  readOnly,
  placeholder,
  actions,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  textarea?: boolean
  rows?: number
  readOnly?: boolean
  placeholder?: string
  actions?: ReactNode
}) {
  const cls =
    'w-full text-sm bg-surface-secondary border border-th-border rounded-lg px-3 py-2 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent'
  return (
    <div>
      <label className="text-sm text-secondary flex items-center gap-2 mb-1.5">
        <span>{label}</span>
        {actions}
      </label>
      {textarea ? (
        <textarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows ?? 3}
          readOnly={readOnly}
          placeholder={placeholder}
          className={clsx('ficus-field', cls, 'resize-y font-mono')}
        />
      ) : (
        <input
          type="text"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          placeholder={placeholder}
          className={clsx('ficus-field', cls)}
        />
      )}
    </div>
  )
}

function squadPresetToForm(st: SquadPresetConfig) {
  return {
    name: st.name,
    workflows: st.workflows ?? null,
    description: st.description ?? '',
    purpose: st.purpose ?? '',
    defaultAgents: st.defaultAgents?.join(', ') ?? '',
    managerInstructions: st.managerInstructions ?? '',
    scheduleTemplates: st.scheduleTemplates?.length ? JSON.stringify(st.scheduleTemplates, null, 2) : '',
  }
}

function csvToArray(csv: string): string[] | null {
  const trimmed = csv.trim()
  if (!trimmed) return null
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
