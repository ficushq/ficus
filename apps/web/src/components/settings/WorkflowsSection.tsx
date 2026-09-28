import clsx from 'clsx'
import { CatalogSearch } from './CatalogSearch'
import { useEffect, useId, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createBlankWorkflow, workflowDefinitionSchema, workflowPresetSchema } from '@ficus/shared'
import type { WorkflowCatalogEntry } from '@ficus/client-core'
import { client } from '../../api/clientInstance'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { Modal } from '../Modal'
import { ConfirmButton } from '../ConfirmButton'
import { WorkflowGraph } from '../WorkflowGraph'
import { WorkflowEditor } from '../squads/WorkflowEditor'
import { useURLState } from '../../hooks/useURLState'
import { readWorkflowDraft, workflowDraftKey, type WorkflowDraft } from '../../lib/workflowDraftStorage'

const field = 'ficus-field w-full min-w-0 border border-th-border bg-surface px-3 py-2 text-sm'

export function WorkflowsSection() {
  const permissions = usePermissions()
  const catalog = useQuery({ ...queries.workflows.list(), enabled: permissions.can('workflows:read') })
  const [search, setSearch] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const editWorkflow = searchParams.get('editWorkflow') ?? ''
  const editing = editWorkflow ? catalog.data?.find((entry) => entry.id === editWorkflow) : undefined
  const editPermissions = usePermissions(editing?.scope?.kind === 'squad' ? editing.scope.squadId : undefined)
  const [newWorkflow] = useURLState({
    param: 'newWorkflow',
    defaultValue: '',
    validate: (value) => (value === '1' || /^copy:[a-z][a-z0-9-]{0,99}$/.test(value) ? value : ''),
  })
  const duplicate = newWorkflow.startsWith('copy:')
  const duplicateEntry = duplicate ? catalog.data?.find((entry) => entry.id === newWorkflow.slice(5)) : undefined
  const draftKey = workflowDraftKey(permissions.identity, newWorkflow)
  const openModal = (param?: 'newWorkflow' | 'editWorkflow', value?: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        next.delete('newWorkflow')
        next.delete('editWorkflow')
        if (param && value) next.set(param, value)
        return next
      },
      { replace: true }
    )
  }
  const closeModal = () => openModal()
  const visible = [...(catalog.data ?? [])]
    .filter((entry) =>
      `${entry.id} ${entry.definition.name} ${entry.description ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    )
    .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
  const canCreate = permissions.can('workflows:create')
  return (
    <div className="min-w-0 w-full space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-primary">Workflows</h3>
          <p className="mt-1 text-sm text-muted">
            Define reusable flows of agents, reviews, and handoffs. Squads choose which workflows to use.
          </p>
        </div>
        {canCreate && (
          <button
            className="ficus-button ficus-button-primary shrink-0 rounded-md px-3 py-2 text-sm"
            onClick={() => openModal('newWorkflow', '1')}
          >
            New workflow
          </button>
        )}
      </header>
      <CatalogSearch label="Search workflows" placeholder="Find a workflow…" value={search} onChange={setSearch} />
      {catalog.isPending ? (
        <p className="text-sm text-muted">Loading workflows…</p>
      ) : catalog.isError ? (
        <p role="alert" className="text-sm text-danger">
          Unable to load workflows.
        </p>
      ) : (
        <div className="space-y-3">
          {visible.map((entry) => (
            <WorkflowCard
              key={entry.id}
              entry={entry}
              canCreate={canCreate}
              onEdit={() => openModal('editWorkflow', entry.id)}
              onDuplicate={() => openModal('newWorkflow', `copy:${entry.id}`)}
            />
          ))}
          {!visible.length && (
            <p className="py-8 text-center text-sm text-muted">
              {search ? 'No workflows match your search.' : 'No workflows configured.'}
            </p>
          )}
        </div>
      )}
      {editWorkflow && catalog.isSuccess && !editing && (
        <p role="alert" className="text-sm text-danger">
          Workflow not found. It may have been deleted or you may not have access.
        </p>
      )}
      {((editing && editPermissions.can('workflows:update')) ||
        (!editWorkflow && newWorkflow && canCreate && (!duplicate || !catalog.isPending))) && (
        <WorkflowModal
          key={editing ? `edit:${editing.id}` : `${newWorkflow}:${draftKey}`}
          entry={editing ?? duplicateEntry}
          duplicate={!editing && duplicate && !!duplicateEntry}
          draftKey={editing ? undefined : draftKey}
          onClose={closeModal}
        />
      )}
    </div>
  )
}

function WorkflowCard({
  entry,
  canCreate,
  onEdit,
  onDuplicate,
}: {
  entry: WorkflowCatalogEntry
  canCreate: boolean
  onEdit: () => void
  onDuplicate: () => void
}) {
  const permissions = usePermissions(entry.scope?.kind === 'squad' ? entry.scope.squadId : undefined)
  const canUpdate = permissions.can('workflows:update')
  const canDelete = permissions.can('workflows:delete')
  const cache = useQueryClient()
  const [preview, setPreview] = useState(false)
  const mutation = useMutation({
    mutationFn: async (action: 'toggle' | 'delete') =>
      action === 'delete'
        ? client.workflows.delete(entry.id, entry.revision)
        : client.workflows.setDisabled(entry.id, entry.revision, !entry.disabled),
    onSuccess: () => cache.invalidateQueries({ queryKey: queryKeys.workflows.all }),
  })
  return (
    <article className="min-w-0 rounded-xl border border-panel-border bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="break-words font-semibold text-primary">{entry.definition.name}</h4>
          <p className="break-all text-xs text-muted">
            {entry.id} ·{' '}
            {entry.scope?.kind === 'squad'
              ? 'Squad preset'
              : entry.scope?.kind === 'user'
                ? 'Personal preset'
                : 'Available to all squads'}
            {entry.disabled ? ' · Disabled' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {canUpdate && (
            <button className="ficus-button text-accent-light" onClick={onEdit}>
              Edit
            </button>
          )}
          {canCreate && (
            <button className="ficus-button text-muted" onClick={onDuplicate}>
              Duplicate
            </button>
          )}
          {canUpdate && (
            <button
              className="ficus-button text-muted"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('toggle')}
            >
              {entry.disabled ? 'Enable' : 'Disable'}
            </button>
          )}
          {canDelete && (
            <ConfirmButton
              onConfirm={() => mutation.mutate('delete')}
              disabled={mutation.isPending}
              className="text-danger"
              label="Delete"
            />
          )}
        </div>
      </div>
      {entry.description && <p className="break-words text-sm text-muted">{entry.description}</p>}
      <button
        className="ficus-button text-sm text-secondary"
        aria-expanded={preview}
        onClick={() => setPreview(!preview)}
      >
        {preview ? 'Hide flow' : 'Preview flow'}
      </button>
      {preview && <WorkflowGraph definition={entry.definition} />}
      {mutation.isError && (
        <p role="alert" className="text-sm text-danger">
          {mutation.error.message}
        </p>
      )}
    </article>
  )
}

function WorkflowModal({
  entry,
  duplicate = false,
  draftKey,
  onClose,
}: {
  entry?: WorkflowCatalogEntry
  duplicate?: boolean
  draftKey?: string
  onClose: () => void
}) {
  const helpId = useId()
  const updating = !!entry && !duplicate
  const cache = useQueryClient()
  const permissions = usePermissions(updating && entry.scope?.kind === 'squad' ? entry.scope.squadId : undefined)
  const allowed = permissions.can(updating ? 'workflows:update' : 'workflows:create')
  const [draft, setDraft] = useState<WorkflowDraft>(
    () =>
      readWorkflowDraft(draftKey) ?? {
        version: 1,
        positions: {},
        id: duplicate ? `${entry!.id.slice(0, 94)}-copy` : (entry?.id ?? ''),
        idEdited: duplicate,
        description: entry?.description ?? '',
        source: {
          kind: 'inline',
          definition: entry
            ? {
                ...structuredClone(entry.definition),
                name: duplicate ? `${entry.definition.name} copy` : entry.definition.name,
              }
            : createBlankWorkflow(),
        },
      }
  )
  const { id, idEdited, description, source } = draft
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    if (!draftKey) return
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }, [draftKey, draft])
  const { data: catalog = [] } = useQuery(queries.workflows.list())
  const nameId =
    source?.kind === 'inline'
      ? source.definition.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 100)
      : ''
  const baseId = (/^[a-z]/.test(nameId) ? nameId : `work-${nameId}`).slice(0, 94)
  let suggestedId = baseId
  for (let suffix = 2; catalog.some((entry) => entry.id === suggestedId); suffix++) suggestedId = `${baseId}-${suffix}`
  const effectiveId = updating || duplicate || idEdited ? id : suggestedId
  const save = useMutation({
    mutationFn: async () => {
      if (!allowed) throw new Error('You do not have permission to save this workflow.')
      if (source?.kind !== 'inline') throw new Error('A flow definition is required.')
      const preset = workflowPresetSchema.parse({
        id: effectiveId,
        description,
        scope: updating ? entry.scope : { kind: 'instance' },
        definition: source.definition,
      })
      return updating ? client.workflows.update(entry.id, entry.revision, preset) : client.workflows.create(preset)
    },
    onSuccess: async () => {
      if (draftKey) {
        try {
          localStorage.removeItem(draftKey)
        } catch {
          /* Storage may be unavailable. */
        }
      }
      await cache.invalidateQueries({ queryKey: queryKeys.workflows.all })
      onClose()
    },
  })
  const valid =
    source?.kind === 'inline' &&
    workflowDefinitionSchema.safeParse(source.definition).success &&
    /^[a-z][a-z0-9-]{0,99}$/.test(effectiveId) &&
    !!description.trim()
  return (
    <Modal
      isOpen
      onClose={save.isPending ? () => {} : onClose}
      title={updating ? `Edit ${entry.definition.name}` : 'New workflow'}
      size="editor"
      mobileFullscreen
      footer={
        <div data-workflow-actions className="flex flex-wrap items-center justify-end gap-3">
          {draftKey && (
            <div className="mr-auto">
              <ConfirmButton
                label="Discard draft"
                className="text-sm text-muted"
                disabled={save.isPending}
                onConfirm={() => {
                  try {
                    localStorage.removeItem(draftKey)
                    onClose()
                  } catch {
                    setStorageError(true)
                  }
                }}
              />
            </div>
          )}
          <button className="ficus-button text-sm text-muted" disabled={save.isPending} onClick={onClose}>
            {updating ? 'Cancel' : 'Close'}
          </button>
          <button
            className={clsx(
              'ficus-button rounded-md px-3 py-2 text-sm',
              !allowed || !valid || save.isPending
                ? 'border border-th-border bg-surface-hover text-muted'
                : 'ficus-button-primary'
            )}
            disabled={!allowed || !valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save workflow'}
          </button>
        </div>
      }
    >
      <div className="flex min-w-0 shrink-0 flex-col gap-3 lg:min-h-0 lg:flex-1">
        <p className="text-sm text-muted">
          {updating
            ? 'Describe what you want to change, or brainstorm with the assistant. Save when you’re ready.'
            : 'Describe the work you want your agents to do. The assistant will build a flow you can refine together.'}
        </p>
        <section
          aria-label="Preset details"
          className={clsx(
            'grid shrink-0 gap-3',
            updating
              ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]'
              : 'sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]'
          )}
        >
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            Name
            <input
              className={`${field} h-10 min-h-10`}
              aria-label="Name"
              aria-describedby={`${helpId}-name`}
              value={source?.kind === 'inline' ? source.definition.name : ''}
              required
              disabled={save.isPending || !allowed}
              onChange={(event) =>
                setDraft((draft) => ({
                  ...draft,
                  source: {
                    ...draft.source,
                    definition: { ...draft.source.definition, name: event.target.value },
                  },
                }))
              }
            />
            <span id={`${helpId}-name`} className="block text-xs text-muted">
              The name people see when choosing a workflow.
            </span>
          </label>
          {!updating && (
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              Preset ID
              <input
                className={`${field} h-10 min-h-10`}
                required
                aria-label="Preset ID"
                aria-describedby={`${helpId}-id`}
                value={effectiveId}
                disabled={updating || save.isPending || !allowed}
                onChange={(event) => {
                  setDraft((draft) => ({ ...draft, idEdited: true, id: event.target.value }))
                }}
                placeholder="security-review"
                maxLength={100}
              />
              <span id={`${helpId}-id`} className="block text-xs text-muted">
                Stable identifier used by squads and CLI commands. It cannot change after creation.
              </span>
            </label>
          )}
          <label className={clsx('flex min-w-0 flex-col gap-1 text-sm', !updating && 'sm:col-span-2 xl:col-span-1')}>
            Description
            <textarea
              className={`${field} h-10 min-h-10`}
              aria-label="Description"
              aria-describedby={`${helpId}-description`}
              value={description}
              disabled={save.isPending || !allowed}
              onChange={(event) => setDraft((draft) => ({ ...draft, description: event.target.value }))}
              rows={1}
              required
              maxLength={4000}
              placeholder="When should squads use this workflow?"
            />
            <span id={`${helpId}-description`} className="block text-xs text-muted">
              Explain when to choose this workflow. Step instructions describe how to carry out the work.
            </span>
          </label>
        </section>
        <WorkflowEditor
          definitionOnly
          nameInHeader
          graphPositions={draft.positions}
          onGraphPositionsChange={(positions) => setDraft((draft) => ({ ...draft, positions }))}
          presetId={updating ? entry.id : undefined}
          preset={{ id: effectiveId, description }}
          onPresetChange={(next) =>
            setDraft((draft) => ({
              ...draft,
              ...(next.id !== effectiveId ? { idEdited: true, id: next.id } : {}),
              description: next.description,
            }))
          }
          value={source}
          onChange={(next) => {
            if (next?.kind === 'inline') setDraft((draft) => ({ ...draft, source: next }))
          }}
          disabled={save.isPending || !allowed}
        />

        {storageError && (
          <p role="alert" className="text-sm text-danger">
            This browser could not save your draft. Keep this page open until you save the workflow.
          </p>
        )}
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {save.error.message}
          </p>
        )}
      </div>
    </Modal>
  )
}
