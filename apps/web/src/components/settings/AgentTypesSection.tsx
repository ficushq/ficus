import { CatalogSearch } from './CatalogSearch'
import { Modal } from '../Modal'
import { providerLabel, type ModelCatalogEntry } from '@ficus/shared'
import { parseDisplayModelSpec } from '../../lib/displayModelSpec'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries, modelCatalogQuery, integrationQueries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  type AgentTypeConfig,
  getAgentTypes,
  createAgentType,
  updateAgentType,
  deleteAgentType,
  revertAgentType,
  revertAgentTypeFields,
  disableAgentType,
  enableAgentType,
  exportAgentTypeYaml,
  getModelTiers,
  updateModelTier,
  type ModelTierConfig,
  deleteModelTier,
} from '../../api/config'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'
import { SharedPromptPicker } from './SharedPromptPicker'
import { SharedPromptsTab } from './SharedPromptsTab'
import { TemplateDiffDialog } from './TemplateDiffDialog'
import { TemplateFieldActions } from './TemplateFieldActions'
import { usePermissions } from '../../hooks/usePermissions'
import { PlusIcon, TrashIcon } from '../icons'
import { formatResolvedModel, modelChainWarnings } from './modelTierUi'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton, LoadingSurface, SkeletonBlock, SkeletonRows } from '../loading/Skeleton'

const PROTECTED_AGENT_TYPES = ['manager', 'system-manager']

export function TierFilterChip({ tierFilter, onClear }: { tierFilter?: string; onClear?: () => void }) {
  if (!tierFilter) return null
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted">Filtered to model tier:</span>
      <button
        onClick={onClear}
        className="ficus-button inline-flex items-center gap-1 rounded-full bg-accent/10 text-accent-light px-2.5 py-0.5 font-medium hover:bg-accent/20"
        title="Clear tier filter"
      >
        <span className="capitalize">{tierFilter}</span>
        <span aria-hidden="true">×</span>
        <span className="sr-only">Clear filter</span>
      </button>
    </div>
  )
}

function AgentTypesTab({ tierFilter, onClearTierFilter }: { tierFilter?: string; onClearTierFilter?: () => void }) {
  const queryClient = useQueryClient()
  const { data: providers = [] } = useQuery(queries.providerAuth.list())
  const { data: agentTypes = [], isLoading } = useQuery({
    queryKey: queryKeys.agentTypes.list(),
    queryFn: getAgentTypes,
  })
  const loadingCardCount = useLoadingShapeCount('settings:agent-types', isLoading ? undefined : agentTypes.length, {
    fallbackCount: 5,
    maxCount: 10,
  })
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [diffId, setDiffId] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canCreateAgentTypes = !permissionsLoading && can('agent-types:create')
  const canUpdateAgentTypes = !permissionsLoading && can('agent-types:update')
  const canDeleteAgentTypes = !permissionsLoading && can('agent-types:delete')

  const diffQuery = useQuery({
    ...queries.agentTypes.templateDiff(diffId ?? ''),
    enabled: !!diffId,
  })

  const revertMutation = useMutation({
    mutationFn: (id: string) => revertAgentType(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
      setDiffId(null)
    },
  })

  const revertFieldsMutation = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: string[] }) => revertAgentTypeFields(id, fields),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
      queryClient.invalidateQueries({
        queryKey: diffId ? queryKeys.agentTypes.templateDiff(diffId) : queryKeys.agentTypes.all,
      })
    },
  })

  if (isLoading) {
    return <CollectionSkeleton label="Loading agent types" count={loadingCardCount} layout="cards" />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted mt-1">Set each role’s instructions, model tier, tools, and access.</p>
        </div>
        {canCreateAgentTypes && (
          <button
            onClick={() => setIsAdding(true)}
            disabled={isAdding}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm bg-accent text-on-accent rounded-md hover:bg-accent/90 disabled:opacity-50 shrink-0"
          >
            New agent type
          </button>
        )}
      </div>

      {canCreateAgentTypes && isAdding && (
        <Modal isOpen onClose={() => setIsAdding(false)} title="New agent type" maxWidth="wide">
          <AddAgentTypeForm onClose={() => setIsAdding(false)} onCreated={() => setIsAdding(false)} />
        </Modal>
      )}

      {agentTypes
        .flatMap((type) =>
          modelChainWarnings(type.resolvedChain ?? type.model, providers).map((warning) => `${type.name}: ${warning}`)
        )
        .map((warning) => (
          <p key={warning} role="alert" className="text-sm text-warning">
            {warning}
          </p>
        ))}
      <CatalogSearch label="Search agent types" placeholder="Find an agent type…" value={search} onChange={setSearch} />
      <TierFilterChip tierFilter={tierFilter} onClear={onClearTierFilter} />
      <div>
        <div className="space-y-3">
          {agentTypes.length === 0 ? (
            <div className="px-4 py-8 text-center text-muted">No agent types configured.</div>
          ) : (
            [...agentTypes]
              .filter(
                (type) =>
                  (!tierFilter || type.tier === tierFilter) &&
                  `${type.name} ${type.id} ${type.description ?? ''}`.toLowerCase().includes(search.toLowerCase())
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((at) => (
                <AgentTypeRow
                  key={at.id}
                  agentType={at}
                  isExpanded={expandedId === at.id}
                  onToggle={() => setExpandedId(expandedId === at.id ? null : at.id)}
                  onShowDiff={() => setDiffId(at.id)}
                  canUpdate={canUpdateAgentTypes}
                  canDelete={canDeleteAgentTypes}
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
        onRevert={() => canUpdateAgentTypes && diffId && revertMutation.mutate(diffId)}
        onRevertFields={(fields) =>
          canUpdateAgentTypes && diffId && revertFieldsMutation.mutate({ id: diffId, fields })
        }
        fieldOverrides={diffQuery.data?.fieldOverrides ?? []}
        isReverting={revertMutation.isPending || revertFieldsMutation.isPending}
      />
    </div>
  )
}

export function ResolvedModelText({
  agentType,
  tierLabel,
}: {
  agentType: Pick<AgentTypeConfig, 'tier' | 'model' | 'resolvedChain' | 'provenance'>
  tierLabel?: string
}) {
  return <p className="text-xs text-muted mt-0.5">{formatResolvedModel(agentType, tierLabel)}</p>
}

function AddAgentTypeForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const queryClient = useQueryClient()
  const { data: modelTiers = [] } = useQuery({ queryKey: ['model-tiers'], queryFn: getModelTiers })
  const [newId, setNewId] = useState('')
  const [form, setForm] = useState<AgentTypeForm>({
    name: '',
    model: '',
    tier: '',
    description: '',
    systemOnly: false,
    systemPrompt: '',
    includes: [],
    skills: [],
    extensions: '',
    toolsAllow: '',
    toolsDeny: '',
    integrationAgentTools: false,
    integrationConversationExport: false,
  })

  const createMutation = useMutation({
    mutationFn: (data: Partial<AgentTypeConfig> & { id: string }) => createAgentType(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
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
    if (!form.model.trim() && !form.tier) {
      alert('A model tier or override is required')
      return
    }
    createMutation.mutate(agentTypeCreatePayload(id, form))
  }

  return (
    <div className="space-y-5">
      <FormField label="ID (unique key)" value={newId} onChange={setNewId} placeholder="e.g. engineer" />
      <FormField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
      <label className="block text-sm text-secondary">
        Tier
        <select
          value={form.tier}
          onChange={(event) => setForm({ ...form, tier: event.target.value })}
          className="ficus-field mt-1 w-full border border-th-border bg-surface px-3 py-2"
        >
          <option value="">None</option>
          {modelTiers.map((tier) => (
            <option key={tier.slug} value={tier.slug}>
              {tier.label}
            </option>
          ))}
        </select>
      </label>
      <ModelSpecListEditor
        label="Override chain (optional)"
        value={form.model}
        onChange={(v) => setForm({ ...form, model: v })}
      />
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.systemOnly}
          onChange={(event) => setForm({ ...form, systemOnly: event.target.checked })}
        />
        <span>
          System-only type
          <span className="block text-xs text-muted">
            Reserved for a Ficus-managed role. Excluded from worker choices.
          </span>
        </span>
      </label>
      <FormField label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
      <FormField
        label="System Prompt"
        value={form.systemPrompt}
        onChange={(v) => setForm({ ...form, systemPrompt: v })}
        textarea
        rows={6}
      />
      <SkillPicker value={form.skills} onChange={(skills) => setForm({ ...form, skills })} />
      <SharedPromptPicker value={form.includes} onChange={(includes) => setForm({ ...form, includes })} />
      <FormField
        label="Extensions (comma-separated)"
        value={form.extensions}
        onChange={(v) => setForm({ ...form, extensions: v })}
      />
      <FormField
        label="Tools Allow (comma-separated)"
        value={form.toolsAllow}
        onChange={(v) => setForm({ ...form, toolsAllow: v })}
      />
      <FormField
        label="Tools Deny (comma-separated)"
        value={form.toolsDeny}
        onChange={(v) => setForm({ ...form, toolsDeny: v })}
      />
      <IntegrationPolicyFields
        agentTools={form.integrationAgentTools}
        conversationExport={form.integrationConversationExport}
        onAgentTools={(value) => setForm({ ...form, integrationAgentTools: value })}
        onConversationExport={(value) => setForm({ ...form, integrationConversationExport: value })}
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

function AgentTypeRow({
  agentType,
  isExpanded,
  onToggle,
  onShowDiff,
  canUpdate,
  canDelete,
}: {
  agentType: AgentTypeConfig
  isExpanded: boolean
  onToggle: () => void
  onShowDiff: () => void
  canUpdate: boolean
  canDelete: boolean
}) {
  const queryClient = useQueryClient()
  const { data: modelTiers = [] } = useQuery({ queryKey: ['model-tiers'], queryFn: getModelTiers })
  const [form, setForm] = useState(() => agentTypeToForm(agentType))
  const [copyMsg, setCopyMsg] = useState('')

  useEffect(() => {
    setForm(agentTypeToForm(agentType))
  }, [agentType])

  const updateMutation = useMutation({
    mutationFn: (data: Partial<AgentTypeConfig>) => updateAgentType(agentType.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteAgentType(agentType.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
    },
  })

  const toggleDisableMutation = useMutation({
    mutationFn: () => (agentType.disabled ? enableAgentType(agentType.id) : disableAgentType(agentType.id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
    },
  })

  const fieldDiffQuery = useQuery({
    ...queries.agentTypes.templateDiff(agentType.id),
    enabled: isExpanded && agentType.hasTemplate,
  })

  const revertFieldMutation = useMutation({
    mutationFn: (field: string) => revertAgentTypeFields(agentType.id, [field]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTypes.templateDiff(agentType.id) })
    },
  })

  const fieldActions = (field: string) => (
    <TemplateFieldActions
      field={field}
      current={fieldDiffQuery.data?.current ?? null}
      template={fieldDiffQuery.data?.template ?? null}
      fieldOverrides={fieldDiffQuery.data?.fieldOverrides ?? agentType.yamlFieldOverrides}
      onRevert={(field) => canUpdate && revertFieldMutation.mutate(field)}
      isReverting={revertFieldMutation.isPending}
    />
  )

  const handleSave = () => {
    updateMutation.mutate(agentTypeUpdatePayload(form))
  }

  const handleExport = async () => {
    try {
      const yaml = await exportAgentTypeYaml(agentType.id)
      await navigator.clipboard.writeText(yaml)
      setCopyMsg('Copied!')
      setTimeout(() => setCopyMsg(''), 2000)
    } catch {
      setCopyMsg('Failed')
      setTimeout(() => setCopyMsg(''), 2000)
    }
  }

  const handleDelete = () => {
    if (window.confirm(`Delete agent type "${agentType.name}"? This cannot be undone.`)) {
      deleteMutation.mutate()
    }
  }

  return (
    <article className="min-w-0 rounded-xl border border-panel-border bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-primary">{agentType.name}</span>

            {agentType.disabled && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-600 dark:text-status-neutral-400">
                Disabled
              </span>
            )}
            {agentType.yamlFieldOverrides.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-review-100 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-400">
                Modified
              </span>
            )}
            {!agentType.hasTemplate && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent-light">Custom</span>
            )}
          </div>
          <p className="text-xs text-muted mt-1">{agentType.id}</p>
          {agentType.description && <p className="text-sm text-secondary mt-2">{agentType.description}</p>}
          <ResolvedModelText
            agentType={agentType}
            tierLabel={modelTiers.find((tier) => tier.slug === agentType.tier)?.label}
          />
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${canUpdate ? 'Edit' : 'View'} ${agentType.name}`}
          className="ficus-button shrink-0 text-sm text-accent-light"
        >
          {canUpdate ? 'Edit' : 'View'}
        </button>
      </div>

      {isExpanded && (
        <Modal
          isOpen={isExpanded}
          onClose={onToggle}
          title={`${canUpdate ? 'Edit' : 'View'} ${agentType.name}`}
          maxWidth="wide"
        >
          <div
            className="space-y-5"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                onToggle()
              }
            }}
          >
            <p className="text-xs text-muted">
              Type ID: <code>{agentType.id}</code>
              {agentType.systemOnly ? ' · System only' : ' · Worker'}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.systemOnly}
                disabled={!canUpdate}
                onChange={(event) => setForm({ ...form, systemOnly: event.target.checked })}
              />
              <span>
                System-only type
                <span className="block text-xs text-muted">
                  Reserved for a Ficus-managed role. Excluded from worker choices.
                </span>
              </span>
              {fieldActions('systemOnly')}
            </label>
            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              {agentType.hasTemplate && agentType.yamlFieldOverrides.length > 0 && (
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
              {canUpdate && !PROTECTED_AGENT_TYPES.includes(agentType.id) && (
                <button
                  onClick={() => toggleDisableMutation.mutate()}
                  disabled={toggleDisableMutation.isPending}
                  className="ficus-button text-xs text-status-attention-600 dark:text-status-attention-400 hover:text-status-attention-800 dark:hover:text-status-attention-300 font-medium"
                >
                  {agentType.disabled ? 'Enable' : 'Disable'}
                </button>
              )}
              {canDelete && !agentType.hasTemplate && !PROTECTED_AGENT_TYPES.includes(agentType.id) && (
                <button
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                  className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium"
                >
                  Delete
                </button>
              )}
            </div>

            {/* Edit form */}
            <div className="space-y-2">
              <FormField
                label="Name"
                value={form.name}
                onChange={(v) => setForm({ ...form, name: v })}
                actions={fieldActions('name')}
              />
              <label className="block text-sm text-secondary">
                Tier
                <select
                  aria-label="Model tier"
                  value={form.tier}
                  onChange={(event) => setForm({ ...form, tier: event.target.value })}
                  className="ficus-field mt-1 w-full border border-th-border bg-surface px-3 py-2"
                >
                  <option value="">Instance default</option>
                  {modelTiers.map((tier) => (
                    <option key={tier.slug} value={tier.slug}>
                      {tier.label}
                    </option>
                  ))}
                </select>
              </label>
              <ModelSpecListEditor
                label="Override chain (optional)"
                value={form.model}
                onChange={(v) => setForm({ ...form, model: v })}
                actions={fieldActions('model')}
              />
              <FormField
                label="Description"
                value={form.description}
                onChange={(v) => setForm({ ...form, description: v })}
                actions={fieldActions('description')}
              />
              <FormField
                label="System Prompt"
                value={form.systemPrompt}
                onChange={(v) => setForm({ ...form, systemPrompt: v })}
                textarea
                rows={8}
                actions={fieldActions('systemPrompt')}
              />
              <SharedPromptPicker
                value={form.includes}
                onChange={(includes) => setForm({ ...form, includes })}
                actions={fieldActions('includes')}
              />
              <ResolvedPromptPreview agentTypeId={agentType.id} />
              <SkillPicker
                value={form.skills}
                onChange={(skills) => setForm({ ...form, skills })}
                actions={fieldActions('skills')}
              />
              <FormField
                label="Extensions (comma-separated)"
                value={form.extensions}
                onChange={(v) => setForm({ ...form, extensions: v })}
                actions={fieldActions('extensions')}
              />
              <FormField
                label="Tools Allow (comma-separated)"
                value={form.toolsAllow}
                onChange={(v) => setForm({ ...form, toolsAllow: v })}
                actions={fieldActions('toolsAllow')}
              />
              <FormField
                label="Tools Deny (comma-separated)"
                value={form.toolsDeny}
                onChange={(v) => setForm({ ...form, toolsDeny: v })}
                actions={fieldActions('toolsDeny')}
              />
              <IntegrationPolicyFields
                agentTools={form.integrationAgentTools}
                conversationExport={form.integrationConversationExport}
                onAgentTools={(value) => setForm({ ...form, integrationAgentTools: value })}
                onConversationExport={(value) => setForm({ ...form, integrationConversationExport: value })}
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
            </div>
          </div>
        </Modal>
      )}
    </article>
  )
}

/**
 * Read-only view of the prompt agents of this type actually receive: the
 * type's own system prompt with its enabled includes composed in. The server
 * composes it, so the preview fetches the agent type detail rather than
 * assembling the text here — a client-side copy would drift from what the
 * runtime builds. Collapsed by default, and the detail query only runs once
 * the operator opens it.
 */
function ResolvedPromptPreview({ agentTypeId }: { agentTypeId: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [copyMsg, setCopyMsg] = useState('')
  const { data, isLoading, error } = useQuery({ ...queries.agentTypes.detail(agentTypeId), enabled: isOpen })
  const resolved = data?.resolvedSystemPrompt ?? ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resolved)
      setCopyMsg('Copied!')
    } catch {
      setCopyMsg('Failed')
    }
    setTimeout(() => setCopyMsg(''), 2000)
  }

  return (
    <details
      className="rounded border border-th-border bg-surface-secondary px-2 py-1"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-muted">Resolved prompt</summary>
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">
            What agents of this type receive before runtime sections (workspace, memory, schedules).
          </p>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!resolved}
            className="ficus-button shrink-0 text-xs text-accent-light hover:text-link-hover disabled:opacity-50"
          >
            {copyMsg || 'Copy'}
          </button>
        </div>
        {error ? (
          <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
            Couldn&apos;t load the resolved prompt: {(error as Error).message}
          </p>
        ) : (
          <pre className="ficus-field whitespace-pre-wrap font-mono text-xs max-h-96 overflow-auto">
            {isLoading ? 'Loading…' : resolved}
          </pre>
        )}
      </div>
    </details>
  )
}

// ============================================================================
// Model Spec List Editor
// ============================================================================

/**
 * Editor for a comma-separated model priority list. Renders each candidate as
 * its own text input with reorder (up/down) and remove controls, plus an
 * "Add" button. A single spec renders as one input. Serializes back to a
 * comma-separated string on change.
 *
 * The list is kept in local state (not re-derived from `value` on every
 * render) so that empty entries — e.g. a freshly added blank input — survive
 * the comma-separated round-trip. A ref tracks the last value we emitted so
 * we only resync from the prop when the change originated externally.
 */
function ModelSpecListEditor({
  label,
  value,
  onChange,
  actions,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  actions?: ReactNode
}) {
  const [specs, setSpecs] = useState(() => parseModelSpecs(value))
  const lastEmitted = useRef(value)

  useEffect(() => {
    // Only resync when the change came from outside this component.
    if (value !== lastEmitted.current) {
      setSpecs(parseModelSpecs(value))
      lastEmitted.current = value
    }
  }, [value])

  const update = (next: string[]) => {
    setSpecs(next)
    const joined = next.join(',')
    lastEmitted.current = joined
    onChange(joined)
  }

  const updateSpec = (index: number, spec: string) => {
    const next = [...specs]
    next[index] = spec
    update(next)
  }

  const removeSpec = (index: number) => {
    update(specs.filter((_, i) => i !== index))
  }

  const moveSpec = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= specs.length) return
    const next = [...specs]
    ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
    update(next)
  }

  const addSpec = () => {
    update([...specs, ''])
  }

  return (
    <div>
      <label className="text-xs text-muted flex items-center gap-2 mb-1">
        <span>{label}</span>
        {actions}
      </label>
      <div className="space-y-1">
        {specs.map((spec, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className="text-xs text-muted font-mono w-5 text-right shrink-0">{i + 1}.</span>
            <input
              type="text"
              value={spec}
              onChange={(e) => updateSpec(i, e.target.value)}
              placeholder="provider:model-id[:thinking-level]"
              className="ficus-field flex-1 text-sm bg-surface-secondary border border-th-border px-2 py-1 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => moveSpec(i, 'up')}
              disabled={i === 0}
              className="ficus-button text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed shrink-0 px-1"
              title="Move up"
            >
              ▲
            </button>
            <button
              type="button"
              onClick={() => moveSpec(i, 'down')}
              disabled={i === specs.length - 1}
              className="ficus-button text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed shrink-0 px-1"
              title="Move down"
            >
              ▼
            </button>
            <button
              type="button"
              onClick={() => removeSpec(i)}
              className="ficus-button text-muted hover:text-status-danger-500 dark:hover:text-status-danger-400 shrink-0 px-1"
              title="Remove"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addSpec}
          className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium flex items-center gap-1"
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Add model
        </button>
        {specs.length > 1 && (
          <p className="text-xs text-muted">
            Candidates are tried in order. The first with an enabled, authenticated provider is used.
          </p>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse a comma-separated model spec string into a list, trimming and dropping empties. */
function parseModelSpecs(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

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
    'w-full text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent'
  return (
    <div>
      <label className="text-xs text-muted flex items-center gap-2 mb-0.5">
        <span>{label}</span>
        {actions}
      </label>
      {textarea ? (
        <textarea
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

function integrationPolicy(
  agentTools: boolean,
  conversationExport: boolean
): AgentTypeConfig['integrationCapabilities'] {
  const capabilities = [
    ...(agentTools ? ['agent_tools' as const] : []),
    ...(conversationExport ? ['conversation_export' as const] : []),
  ]
  return capabilities.length ? { version: 1, allow: { bigbrain: capabilities } } : null
}

function IntegrationPolicyFields({
  agentTools,
  conversationExport,
  onAgentTools,
  onConversationExport,
}: {
  agentTools: boolean
  conversationExport: boolean
  onAgentTools(value: boolean): void
  onConversationExport(value: boolean): void
}) {
  const { can } = usePermissions()
  const { data: connections = [] } = useQuery({
    ...integrationQueries.pool('bigbrain'),
    enabled: can('integrations:read'),
  })
  if (!can('integrations:read') || !connections.some((connection) => connection.enabled)) return null
  return (
    <fieldset className="border-t border-panel-border pt-4 space-y-2">
      <legend className="text-sm">Bigbrain access</legend>
      <p className="text-xs text-muted">
        Choose which Bigbrain capabilities agents of this type may use. Squad connection settings still apply.
      </p>
      <label className="block text-sm">
        <input type="checkbox" checked={agentTools} onChange={(event) => onAgentTools(event.target.checked)} /> Agent
        tools
      </label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={conversationExport}
          onChange={(event) => onConversationExport(event.target.checked)}
        />{' '}
        Conversation export
      </label>
      <p className="text-xs text-muted">
        Agent tools also require explicit tools.allow entries for each bigbrain_* tool.
      </p>
    </fieldset>
  )
}

/**
 * The PUT body replaces the whole row, so the form has to cover every stored
 * field — omitting one stores the server-side default and records it as a
 * deliberate override.
 */
export function agentTypeUpdatePayload(form: AgentTypeForm): Partial<AgentTypeConfig> {
  return {
    systemOnly: form.systemOnly,
    name: form.name,
    model: form.model,
    tier: form.tier || null,
    description: form.description || null,
    systemPrompt: form.systemPrompt,
    includes: form.includes,
    skills: form.skills.length ? form.skills : null,
    extensions: csvToArray(form.extensions),
    toolsAllow: csvToArray(form.toolsAllow),
    toolsDeny: csvToArray(form.toolsDeny),
    integrationCapabilities: integrationPolicy(form.integrationAgentTools, form.integrationConversationExport),
  }
}

/**
 * The POST body for a brand-new type: the same field set as an update, plus the
 * id the operator typed. Sharing the builder keeps a field added to one form
 * from being silently dropped by the other.
 */
export function agentTypeCreatePayload(id: string, form: AgentTypeForm): Partial<AgentTypeConfig> & { id: string } {
  return { id, ...agentTypeUpdatePayload(form) }
}

export type AgentTypeForm = ReturnType<typeof agentTypeToForm>

function agentTypeToForm(at: AgentTypeConfig) {
  return {
    systemOnly: at.systemOnly ?? false,
    name: at.name,
    model: at.model,
    tier: at.tier ?? '',
    description: at.description ?? '',
    systemPrompt: at.systemPrompt,
    includes: at.includes ?? [],
    skills: at.skills ?? [],
    extensions: arrayToCsv(at.extensions),
    toolsAllow: arrayToCsv(at.toolsAllow),
    toolsDeny: arrayToCsv(at.toolsDeny),
    integrationAgentTools:
      at.integrationCapabilities?.version === 1 &&
      Boolean(at.integrationCapabilities.allow.bigbrain?.includes('agent_tools')),
    integrationConversationExport:
      at.integrationCapabilities?.version === 1 &&
      Boolean(at.integrationCapabilities.allow.bigbrain?.includes('conversation_export')),
  }
}

function arrayToCsv(arr: string[] | null): string {
  return arr?.join(', ') ?? ''
}

function csvToArray(csv: string): string[] | null {
  const trimmed = csv.trim()
  if (!trimmed) return null
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function SkillPicker({
  value,
  onChange,
  actions,
}: {
  value: string[]
  onChange: (next: string[]) => void
  actions?: ReactNode
}) {
  const { data: skills = [], isLoading, isSuccess } = useQuery(queries.skills.list())
  const enabledSkills = skills.filter((skill) => !skill.disabled)
  const skillSkeletonCount = useLoadingShapeCount(
    'settings:agent-type-skill-picker',
    isSuccess ? enabledSkills.length : undefined,
    { fallbackCount: 4, maxCount: 8 }
  )
  const selected = new Set(value)
  return (
    <div>
      <label className="text-xs text-muted flex items-center gap-2 mb-1">
        <span>Skills</span>
        {actions}
      </label>
      <div className="border border-th-border rounded bg-surface-secondary p-2 max-h-44 overflow-auto space-y-1">
        {isLoading ? (
          <LoadingSurface label="Loading skills" className="space-y-2">
            <SkeletonRows count={Math.max(1, skillSkeletonCount)}>
              {(index) => (
                <div key={index} className="flex items-center gap-2">
                  <SkeletonBlock className="h-4 w-4" />
                  <SkeletonBlock className={index % 2 ? 'h-4 w-36' : 'h-4 w-48'} />
                </div>
              )}
            </SkeletonRows>
          </LoadingSurface>
        ) : enabledSkills.length === 0 ? (
          <div className="text-xs text-muted">No enabled skills available.</div>
        ) : (
          enabledSkills.map((skill) => (
            <label key={skill.id} className="flex items-start gap-2 text-sm text-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(skill.id)}
                onChange={(event) => {
                  const next = new Set(selected)
                  if (event.target.checked) next.add(skill.id)
                  else next.delete(skill.id)
                  onChange([...next])
                }}
              />
              <span>
                <span className="font-medium">{skill.name}</span>{' '}
                <span className="text-xs text-muted font-mono">{skill.id}</span>
                {skill.description && <span className="block text-xs text-muted">{skill.description}</span>}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  )
}

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function splitChainEntry(entry: string): { provider: string; model: string; effort: string } {
  const parsed = parseDisplayModelSpec(entry)
  return { provider: parsed.provider, model: parsed.modelId, effort: parsed.thinkingLevel ?? 'off' }
}
export function TierChainEditor({
  tier,
  providers,
  onSave,
  derivedFallbacks = [],
  catalog = [],
  disabled = false,
}: {
  tier: ModelTierConfig
  providers: string[]
  onSave: (tier: ModelTierConfig) => void
  derivedFallbacks?: string[]
  catalog?: ModelCatalogEntry[]
  disabled?: boolean
}) {
  const [entries, setEntries] = useState(() => tier.chain.split(',').filter(Boolean))
  const [customRows, setCustomRows] = useState<Set<number>>(() => new Set())
  const [dragged, setDragged] = useState<number | null>(null)
  useEffect(() => setEntries(tier.chain.split(',').filter(Boolean)), [tier.chain])
  const commit = (next: string[]) => {
    if (disabled) return
    setEntries(next)
    onSave({ ...tier, chain: next.join(',') })
  }
  const updatePart = (index: number, part: 'provider' | 'model' | 'effort', value: string, save = false) => {
    const parsed = splitChainEntry(entries[index])
    parsed[part] = value
    const next = entries.map((entry, i) =>
      i === index ? `${parsed.provider}:${parsed.model}:${parsed.effort}` : entry
    )
    if (save) commit(next)
    else setEntries(next)
  }
  return (
    <fieldset disabled={disabled} className="mt-4 min-w-0 space-y-3">
      {entries.map((entry, index) => {
        const parsed = splitChainEntry(entry)
        const providerOptions = [...new Set([...providers, ...catalog.map((model) => model.provider), parsed.provider])]
          .filter(Boolean)
          .sort()
        const models = catalog.filter((model) => model.provider === parsed.provider)
        const metadata = models.find((model) => model.id === parsed.model)
        const custom = customRows.has(index) || !metadata
        const move = (to: number) => {
          const next = [...entries]
          const [item] = next.splice(index, 1)
          next.splice(to, 0, item)
          setCustomRows(new Set())
          commit(next)
        }
        return (
          <div
            key={index}
            draggable={!disabled}
            onDragStart={() => setDragged(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragged == null || dragged === index) return
              const next = [...entries]
              const [item] = next.splice(dragged, 1)
              next.splice(index, 0, item)
              setDragged(null)
              commit(next)
            }}
            className="rounded-xl bg-surface-secondary/60 p-3 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">
                {index === 0 ? 'Primary model' : `Fallback ${index}`}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  aria-label={`Move ${tier.label} model ${index + 1} up`}
                  onClick={() => move(index - 1)}
                  className="ficus-button px-2 text-muted disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={disabled || index === entries.length - 1}
                  aria-label={`Move ${tier.label} model ${index + 1} down`}
                  onClick={() => move(index + 1)}
                  className="ficus-button px-2 text-muted disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${tier.label} model ${index + 1}`}
                  className="ficus-button px-2 text-xs text-muted hover:text-danger"
                  onClick={() => commit(entries.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,.75fr)]">
              <label className="min-w-0 space-y-1 text-xs text-muted">
                <span>Provider</span>
                <select
                  aria-label={`${tier.label} provider position ${index + 1}`}
                  value={parsed.provider}
                  onChange={(event) => updatePart(index, 'provider', event.target.value, true)}
                  className="ficus-field w-full min-w-0 bg-surface p-2 text-sm"
                >
                  {providerOptions.map((provider) => (
                    <option key={provider} value={provider}>
                      {providerLabel(provider)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="min-w-0 space-y-1">
                <label className="block text-xs text-muted">
                  <span className="block mb-1">Model</span>
                  <select
                    aria-label={`${tier.label} model selection position ${index + 1}`}
                    value={custom ? '__custom__' : parsed.model}
                    className="ficus-field w-full min-w-0 bg-surface p-2 text-sm"
                    onChange={(event) => {
                      const value = event.target.value
                      setCustomRows((previous) => {
                        const next = new Set(previous)
                        if (value === '__custom__') next.add(index)
                        else next.delete(index)
                        return next
                      })
                      if (value !== '__custom__') updatePart(index, 'model', value, true)
                    }}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                    <option value="__custom__">Custom model ID…</option>
                  </select>
                </label>
                {custom && (
                  <input
                    aria-label={`${tier.label} model position ${index + 1}`}
                    value={parsed.model}
                    onChange={(event) => updatePart(index, 'model', event.target.value)}
                    onBlur={() => commit(entries)}
                    placeholder="Enter model ID"
                    className="ficus-field w-full min-w-0 bg-surface p-2 font-mono text-sm"
                  />
                )}
                {metadata && (
                  <p className="text-xs text-muted">
                    {Math.round(metadata.contextWindow / 1000)}k context
                    {metadata.input.includes('image') ? ' · Images' : ''}
                    {metadata.reasoning ? ' · Reasoning' : ''}
                  </p>
                )}
              </div>
              <label className="min-w-0 space-y-1 text-xs text-muted">
                <span>Reasoning</span>
                <select
                  aria-label={`${tier.label} effort position ${index + 1}`}
                  value={parsed.effort}
                  onChange={(event) => {
                    updatePart(index, 'effort', event.target.value, true)
                  }}
                  className="ficus-field w-full min-w-0 bg-surface p-2 text-sm"
                >
                  {EFFORTS.map((effort) => (
                    <option key={effort}>{effort}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )
      })}
      {derivedFallbacks.map((fallback, index) => (
        <div key={fallback} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-muted">
          <span className="w-6">{entries.length + index + 1}.</span>
          <code className="flex-1">{fallback}</code>
          <span className="rounded bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-light">via OpenRouter</span>
        </div>
      ))}
      <button
        onClick={() => setEntries([...entries, `${providers[0] ?? 'provider'}:model:medium`])}
        className="ficus-button text-sm text-accent-light"
      >
        + Add provider position
      </button>
    </fieldset>
  )
}

function ModelTiersTab({ onUsedBy }: { onUsedBy: (slug: string) => void }) {
  const queryClient = useQueryClient()
  const [warning, setWarning] = useState('')
  const { can } = usePermissions()
  const { data: catalog = [], isError: catalogUnavailable } = useQuery(modelCatalogQuery())
  const { data: providers = [] } = useQuery(queries.providerAuth.list())
  const { data: tiers = [], isLoading, isSuccess } = useQuery({ queryKey: ['model-tiers'], queryFn: getModelTiers })
  const tierSkeletonCount = useLoadingShapeCount('settings:model-tiers', isSuccess ? tiers.length : undefined, {
    fallbackCount: 3,
    maxCount: 8,
  })
  const mutation = useMutation({
    mutationFn: updateModelTier,
    onSuccess: (result: ModelTierConfig & { warnings?: string[] }) => {
      setWarning(result.warnings?.join('; ') ?? '')
      queryClient.invalidateQueries({ queryKey: ['model-tiers'] })
    },
  })
  const remove = useMutation({
    mutationFn: deleteModelTier,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['model-tiers'] }),
  })
  if (isLoading) return <CollectionSkeleton label="Loading model tiers" count={tierSkeletonCount} />
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Each tier tries its primary model first, then falls back in order. Changes save as you edit.
      </p>
      {catalogUnavailable && (
        <p className="text-xs text-muted">Model catalog unavailable. You can still enter model IDs manually.</p>
      )}
      {(mutation.error || remove.error) && (
        <p role="alert" className="text-sm text-danger">
          {String(mutation.error ?? remove.error)}
        </p>
      )}
      {warning && (
        <p role="alert" className="text-warning">
          {warning}
        </p>
      )}
      {tiers.map((tier: ModelTierConfig) => (
        <div key={tier.slug} className="border-b border-panel-border pb-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{tier.label}</strong>
            <span>
              <button className="ficus-button text-sm text-accent-light" onClick={() => onUsedBy(tier.slug)}>
                Used by {tier.usedByCount} types
              </button>{' '}
              <button
                disabled={!can('agent-types:update') || tier.usedByCount > 0 || remove.isPending}
                onClick={() => remove.mutate(tier.slug)}
                className="ficus-button ml-3 text-sm text-danger"
              >
                Remove tier
              </button>
            </span>
          </div>
          {modelChainWarnings(tier.chain, providers).map((item) => (
            <p key={item} role="alert" className="text-sm text-warning">
              {item}
            </p>
          ))}
          <TierChainEditor
            tier={tier}
            catalog={catalog}
            disabled={!can('agent-types:update') || mutation.isPending}
            providers={providers.map((provider) => provider.provider)}
            derivedFallbacks={tier.derivedOpenRouterFallbacks}
            onSave={(next) => mutation.mutate(next)}
          />
        </div>
      ))}
      <button
        disabled={!can('agent-types:update') || mutation.isPending}
        onClick={() => {
          const slug = prompt('Tier slug (kebab-case)')
          if (slug)
            mutation.mutate({
              slug,
              label: slug,
              description: null,
              chain: 'provider:model:medium',
              sortOrder: tiers.length * 10 + 10,
              usedByCount: 0,
            })
        }}
        className="ficus-button ficus-button-primary rounded bg-accent px-3 py-2 text-on-accent"
      >
        Add custom tier
      </button>
    </div>
  )
}

type AgentTypesView = 'types' | 'tiers' | 'includes'

const AGENT_TYPES_VIEW_OPTIONS: readonly SegmentedControlOption<AgentTypesView>[] = [
  { value: 'types', label: 'Types' },
  { value: 'tiers', label: 'Model tiers' },
  { value: 'includes', label: 'Shared prompts' },
]

export function AgentTypesSection() {
  const [tab, setTab] = useState<AgentTypesView>('types')
  const [tierFilter, setTierFilter] = useState<string | undefined>()
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-primary">Agent Types</h3>
        <p className="mt-1 text-sm text-muted">
          Define agent roles, choose the models they use, and edit the shared prompt blocks they include.
        </p>
        <SegmentedControl
          size="compact"
          ariaLabel="Agent types view"
          options={AGENT_TYPES_VIEW_OPTIONS}
          value={tab}
          onChange={(next) => {
            if (next === 'types') setTierFilter(undefined)
            setTab(next)
          }}
          className="mt-3"
        />
      </div>
      {tab === 'types' && <AgentTypesTab tierFilter={tierFilter} onClearTierFilter={() => setTierFilter(undefined)} />}
      {tab === 'tiers' && (
        <ModelTiersTab
          onUsedBy={(slug) => {
            setTierFilter(slug)
            setTab('types')
          }}
        />
      )}
      {tab === 'includes' && <SharedPromptsTab />}
    </div>
  )
}
