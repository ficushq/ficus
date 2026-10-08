import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../Modal'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  createSharedPrompt,
  deleteSharedPrompt,
  disableSharedPrompt,
  enableSharedPrompt,
  revertSharedPrompt,
  revertSharedPromptFields,
  updateSharedPrompt,
  type SharedPromptConfig,
} from '../../api/config'
import { TemplateFieldActions } from './TemplateFieldActions'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

/**
 * The API refuses to delete an include an agent type still references and names
 * the referencing types in `referencedBy`. The thrown Error only carries the
 * message, so pull the ids off the parsed payload and show them together.
 */
export function deleteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const payload = (error as { payload?: unknown } | null)?.payload
  const referencedBy =
    payload && typeof payload === 'object' ? (payload as { referencedBy?: unknown }).referencedBy : undefined
  if (Array.isArray(referencedBy) && referencedBy.length) return `${message} — used by: ${referencedBy.join(', ')}`
  return message
}

/** Pure list of include cards — rendered by the tab, testable without a query client. */
export function SharedPromptList({
  includes,
  onEdit,
  onToggle,
  onDelete,
  canWrite,
}: {
  includes: SharedPromptConfig[]
  onEdit: (include: SharedPromptConfig) => void
  onToggle: (include: SharedPromptConfig) => void
  onDelete: (include: SharedPromptConfig) => void
  canWrite: boolean
}) {
  if (!includes.length) return <p className="py-8 text-center text-muted">No shared prompts configured.</p>
  return (
    <div className="space-y-3">
      {includes.map((include) => (
        <article
          key={include.id}
          className="min-w-0 rounded-xl border border-panel-border bg-surface p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="font-semibold text-primary flex items-center gap-2 flex-wrap">
              <span>{include.name}</span>
              {include.yamlFieldOverrides.length > 0 && (
                <span className="rounded-full bg-status-attention-500/10 px-2 py-0.5 text-[11px] text-status-attention-600 dark:text-status-attention-400">
                  Modified from template
                </span>
              )}
              {include.disabled && (
                <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] text-muted">Disabled</span>
              )}
            </div>
            <div className="text-xs text-muted font-mono">{include.id}</div>
            {include.description && <p className="text-sm text-secondary mt-1">{include.description}</p>}
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap justify-end">
            {canWrite && (
              <button className="ficus-button ficus-button-link text-sm" onClick={() => onEdit(include)}>
                Edit
              </button>
            )}
            {canWrite && (
              <button className="ficus-button ficus-button-link text-sm" onClick={() => onToggle(include)}>
                {include.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
            {canWrite && !include.hasTemplate && (
              <button className="ficus-button ficus-button-danger px-2 py-1 text-sm" onClick={() => onDelete(include)}>
                Delete
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}

type IncludeDraft = { id: string; name: string; description: string; content: string }

export function SharedPromptsTab() {
  const queryClient = useQueryClient()
  const { data: includes = [], isLoading } = useQuery(queries.sharedPrompts.list())
  const loadingCardCount = useLoadingShapeCount('settings:shared-prompts', isLoading ? undefined : includes.length, {
    fallbackCount: 4,
    maxCount: 10,
  })
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWrite = !permissionsLoading && can('agent-types:update')
  const [editing, setEditing] = useState<IncludeDraft | null>(null)
  const [isNew, setIsNew] = useState(false)
  // Every mutation on this tab reports here: a failed toggle or revert used to
  // vanish silently, leaving the operator to guess from unchanged cards.
  const [actionError, setActionError] = useState('')

  const existing = editing && !isNew ? includes.find((include) => include.id === editing.id) : undefined
  const editingDiffQuery = useQuery({
    ...queries.sharedPrompts.templateDiff(existing?.hasTemplate ? existing.id : ''),
    enabled: !!existing?.hasTemplate,
  })

  // Include content feeds every agent type's resolved prompt, so refresh the
  // agent type caches alongside the include list.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.sharedPrompts.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
  }

  const save = useMutation({
    mutationFn: (draft: IncludeDraft) =>
      isNew
        ? createSharedPrompt({
            id: draft.id.trim(),
            name: draft.name.trim(),
            content: draft.content,
            description: draft.description.trim() || null,
          })
        : updateSharedPrompt(draft.id, {
            content: draft.content,
            name: draft.name.trim(),
            description: draft.description.trim() || null,
          }),
    onSuccess: () => {
      setActionError('')
      setEditing(null)
      invalidate()
    },
  })

  const toggle = useMutation({
    mutationFn: (include: SharedPromptConfig) =>
      include.disabled ? enableSharedPrompt(include.id) : disableSharedPrompt(include.id),
    onSuccess: () => {
      setActionError('')
      invalidate()
    },
    onError: (error) => setActionError(deleteErrorMessage(error)),
  })

  const remove = useMutation({
    mutationFn: (include: SharedPromptConfig) => deleteSharedPrompt(include.id),
    onSuccess: () => {
      setActionError('')
      invalidate()
    },
    onError: (error) => setActionError(deleteErrorMessage(error)),
  })

  const revertAll = useMutation({
    mutationFn: (id: string) => revertSharedPrompt(id),
    onSuccess: (_data, id) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedPrompts.templateDiff(id) })
    },
    onError: (error) => setActionError(deleteErrorMessage(error)),
  })

  const revertFields = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: string[] }) => revertSharedPromptFields(id, fields),
    onSuccess: (_data, variables) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedPrompts.templateDiff(variables.id) })
    },
    onError: (error) => setActionError(deleteErrorMessage(error)),
  })

  // A revert rewrites the stored record, so refresh the open editor from the
  // refetched include instead of leaving the pre-revert text on screen.
  useEffect(() => {
    if (!existing) return
    setEditing((draft) =>
      draft && draft.id === existing.id
        ? { ...draft, name: existing.name, description: existing.description ?? '', content: existing.content }
        : draft
    )
  }, [existing])

  const fieldActions = (field: string) =>
    existing?.hasTemplate ? (
      <TemplateFieldActions
        field={field}
        current={editingDiffQuery.data?.current ?? null}
        template={editingDiffQuery.data?.template ?? null}
        fieldOverrides={editingDiffQuery.data?.fieldOverrides ?? existing.yamlFieldOverrides}
        onRevert={(field) => canWrite && revertFields.mutate({ id: existing.id, fields: [field] })}
        isReverting={revertFields.isPending}
      />
    ) : null

  const openEditor = (include: SharedPromptConfig) => {
    save.reset()
    setActionError('')
    setIsNew(false)
    setEditing({
      id: include.id,
      name: include.name,
      description: include.description ?? '',
      content: include.content,
    })
  }

  const openNew = () => {
    save.reset()
    setActionError('')
    setIsNew(true)
    setEditing({ id: '', name: '', description: '', content: '' })
  }

  if (isLoading) return <CollectionSkeleton label="Loading shared prompts" count={loadingCardCount} layout="cards" />

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted">
          Shared prompt blocks agent types compose into their system prompt, in the order each type lists them.
        </p>
        {canWrite && (
          <button
            className="ficus-button ficus-button-primary shrink-0 px-3 py-1.5 text-sm rounded-md"
            onClick={openNew}
          >
            New shared prompt
          </button>
        )}
      </div>

      {actionError && <div className="text-sm text-status-danger-600 dark:text-status-danger-400">{actionError}</div>}

      <SharedPromptList
        includes={includes}
        onEdit={openEditor}
        onToggle={(include) => toggle.mutate(include)}
        onDelete={(include) => {
          setActionError('')
          if (window.confirm(`Delete shared prompt "${include.name}"? This cannot be undone.`)) remove.mutate(include)
        }}
        canWrite={canWrite}
      />

      {canWrite && editing && (
        <Modal
          isOpen
          onClose={() => setEditing(null)}
          title={isNew ? 'New shared prompt' : `Edit ${editing.name}`}
          maxWidth="wide"
        >
          <form
            className="space-y-4"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditing(null)
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate(editing)
            }}
          >
            <div>
              <label className="text-xs text-muted mb-1 block">Include ID</label>
              <input
                className="ficus-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Include ID"
                required
                placeholder="squad-rules"
                value={editing.id}
                disabled={!isNew}
                onChange={(event) => setEditing({ ...editing, id: event.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Name</label>
              <input
                className="ficus-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Name"
                required
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Description</label>
              <input
                className="ficus-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Description"
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted flex items-center gap-2 mb-1">
                <span>Content</span>
                {fieldActions('content')}
              </label>
              <textarea
                className="ficus-field w-full px-3 py-2 font-mono text-sm bg-input border border-th-border"
                aria-label="Content"
                required
                rows={18}
                value={editing.content}
                onChange={(event) => setEditing({ ...editing, content: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md disabled:opacity-50"
                disabled={save.isPending}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              {existing?.hasTemplate && existing.yamlFieldOverrides.length > 0 && (
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm text-status-attention-600 dark:text-status-attention-400 disabled:opacity-50"
                  disabled={revertAll.isPending}
                  onClick={() => {
                    if (window.confirm(`Revert "${existing.id}" to its template?`)) revertAll.mutate(existing.id)
                  }}
                >
                  Revert to template
                </button>
              )}
              {save.isError && (
                <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
                  {(save.error as Error).message}
                </span>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
