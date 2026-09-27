import { ChannelIdsEditor } from './ChannelIdsEditor'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { type ChannelInstanceConfig } from '../../api/config'
import { useChannelApi } from './channelApi'
import { useSquadsApi } from './squadsApi'
import { TemplateDiffDialog } from './TemplateDiffDialog'
import { TemplateFieldActions } from './TemplateFieldActions'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'
import {
  PROVIDERS,
  type ProviderId,
  type OverrideRow,
  getProviderMeta,
  generateChannelId,
  buildProviderConfig,
  extractProviderConfigValue,
  mapToOverrideRows,
  overrideRowsToMap,
  invalidOverrideRowIndexes,
} from './channelFormHelpers'

export function ChannelsSection({ provider }: { provider?: ProviderId } = {}) {
  const queryClient = useQueryClient()
  const { revertChannelInstance, revertChannelInstanceFields } = useChannelApi()
  const { data: allChannels = [], isLoading } = useQuery(queries.channelInstances.list())
  const channels = provider ? allChannels.filter((channel) => channel.provider === provider) : allChannels
  const loadingRowCount = useLoadingShapeCount('settings:channels', isLoading ? undefined : channels.length, {
    fallbackCount: 3,
    maxCount: 8,
  })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [diffId, setDiffId] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canCreateChannels = !permissionsLoading && can('channels:create')
  const canUpdateChannels = !permissionsLoading && can('channels:update')
  const canDeleteChannels = !permissionsLoading && can('channels:delete')

  const diffQuery = useQuery({
    ...queries.channelInstances.templateDiff(diffId ?? ''),
    enabled: !!diffId,
  })

  const revertMutation = useMutation({
    mutationFn: (id: string) => revertChannelInstance(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
      setDiffId(null)
    },
  })

  const revertFieldsMutation = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: string[] }) => revertChannelInstanceFields(id, fields),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
      if (diffId) queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.templateDiff(diffId) })
    },
  })

  if (isLoading) {
    return <CollectionSkeleton label="Loading channels" count={loadingRowCount} />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">{provider ? 'Channel routing' : 'Channels'}</h3>
          <p className="text-sm text-muted mt-1">
            Choose the default squad and channel overrides for incoming conversations.
          </p>
        </div>
        {canCreateChannels && (
          <button
            onClick={() => setIsAdding(true)}
            disabled={isAdding}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm bg-accent text-on-accent rounded-md hover:bg-accent/90 disabled:opacity-50 shrink-0"
          >
            + Add New
          </button>
        )}
      </div>

      {canCreateChannels && isAdding && (
        <AddChannelForm
          initialProvider={provider}
          onClose={() => setIsAdding(false)}
          onCreated={() => {
            setIsAdding(false)
          }}
        />
      )}

      <div className="ficus-section overflow-hidden">
        <div className="divide-y divide-th-border">
          {channels.length === 0 ? (
            <div className="px-4 py-8 text-center text-muted">No channels configured.</div>
          ) : (
            [...channels]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  isExpanded={expandedId === ch.id}
                  onToggle={() => setExpandedId(expandedId === ch.id ? null : ch.id)}
                  onShowDiff={() => setDiffId(ch.id)}
                  canUpdate={canUpdateChannels}
                  canDelete={canDeleteChannels}
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
        onRevert={() => canUpdateChannels && diffId && revertMutation.mutate(diffId)}
        onRevertFields={(fields) => canUpdateChannels && diffId && revertFieldsMutation.mutate({ id: diffId, fields })}
        fieldOverrides={diffQuery.data?.fieldOverrides ?? []}
        isReverting={revertMutation.isPending || revertFieldsMutation.isPending}
      />
    </div>
  )
}

// ============================================================================
// Shared field components
// ============================================================================

/** A <select> of squads. If `value` isn't among the known squads (e.g. it was
 * deleted after being referenced), it's kept as a visibly-flagged option so
 * saving never silently swaps it out from under the operator. */
function SquadDropdown({
  value,
  squads,
  onChange,
  required,
  invalid,
  describedBy,
  id,
  placeholder,
  ariaLabel,
}: {
  value: string | null
  squads: { id: string; name: string }[]
  onChange: (id: string | null) => void
  required?: boolean
  invalid?: boolean
  describedBy?: string
  id?: string
  placeholder?: string
  ariaLabel?: string
}) {
  const isUnknown = !!value && !squads.some((s) => s.id === value)
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value || null)}
      id={id}
      required={required}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-label={ariaLabel}
      className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary  focus:ring-1 focus:ring-accent"
    >
      <option value="" disabled={required}>
        {placeholder ?? 'Select a squad…'}
      </option>
      {isUnknown && <option value={value ?? ''}>⚠ Unknown squad ({value})</option>}
      {squads.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )
}

const DEFAULT_SQUAD_ERROR = 'Select a default squad to route new conversations, even when overrides are configured.'

function DefaultSquadField({
  defaultSquadId,
  onChange,
  actions,
  showError,
}: {
  defaultSquadId: string | null
  showError?: boolean
  onChange: (id: string | null) => void
  actions?: ReactNode
}) {
  const { listSquads } = useSquadsApi()
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), queryFn: () => listSquads() })

  const id = useId()
  const invalid = showError && !defaultSquadId

  return (
    <div>
      <label htmlFor={id} className="text-xs text-muted flex items-center gap-2 mb-0.5">
        <span>Default Squad (required)</span>
        {actions}
      </label>
      <SquadDropdown
        id={id}
        value={defaultSquadId}
        squads={squads}
        onChange={onChange}
        required
        invalid={invalid}
        describedBy={`${id}-help${invalid ? ` ${id}-error` : ''}`}
        ariaLabel="Default Squad"
      />
      <p id={`${id}-help`} className="text-xs text-muted mt-1">
        Routes new conversations without a matching channel override. Existing conversations may continue with their
        current squad.
      </p>
      {invalid && (
        <p id={`${id}-error`} role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400 mt-1">
          {DEFAULT_SQUAD_ERROR}
        </p>
      )}
    </div>
  )
}

function ProviderConfigField({
  provider,
  value,
  onChange,
  actions,
}: {
  provider: string
  value: string
  onChange: (v: string) => void
  actions?: ReactNode
}) {
  const meta = getProviderMeta(provider)
  return (
    <div>
      <FormField
        label={meta.configField.label}
        value={value}
        onChange={onChange}
        placeholder={meta.configField.placeholder}
        actions={actions}
      />
      <p className="text-xs text-muted mt-1">{meta.configField.hint}</p>
    </div>
  )
}

/** Radio-card provider picker. Comes first in the create form — every other
 * field's labels and placeholders adapt to the chosen provider. */
function ProviderPicker({ value, onChange }: { value: ProviderId | null; onChange: (p: ProviderId) => void }) {
  return (
    <fieldset>
      <legend className="text-xs text-muted mb-1.5">Provider</legend>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {PROVIDERS.map((p) => (
          <label
            key={p.id}
            className={clsx(
              'flex items-center gap-2 rounded-md border p-3 cursor-pointer',
              value === p.id ? 'border-accent bg-surface-secondary/40' : 'border-th-border'
            )}
          >
            <input
              type="radio"
              name="channel-provider"
              value={p.id}
              checked={value === p.id}
              onChange={() => onChange(p.id)}
              className="text-accent-light focus:ring-accent"
            />
            <span className="text-sm font-medium text-primary">{p.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** List builder for the channelSquadMap: zero or more [channel ID, squad] rows,
 * replacing the raw JSON textarea. Serializes to the exact same map shape the
 * backend already stores. */
export function SquadOverridesEditor({
  provider,
  rows,
  onChange,
  actions,
}: {
  provider: string
  rows: OverrideRow[]
  onChange: (rows: OverrideRow[]) => void
  actions?: ReactNode
}) {
  const { listSquads } = useSquadsApi()
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), queryFn: () => listSquads() })
  const meta = getProviderMeta(provider)
  const invalidIdx = new Set(invalidOverrideRowIndexes(rows))

  const updateRow = (i: number, patch: Partial<OverrideRow>) => {
    const next = rows.slice()
    next[i] = { ...next[i], ...patch }
    onChange(next)
  }
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const addRow = () => onChange([...rows, { key: '', squadId: '' }])

  return (
    <div>
      <label className="text-xs text-muted flex items-center gap-2 mb-0.5">
        <span>Squad overrides</span>
        {actions}
      </label>
      <p className="text-xs text-muted mb-2">
        Optional. Route messages from a specific {meta.label} channel to a different squad than the default above.
      </p>
      {rows.length > 0 && (
        <div className="space-y-2 mb-2">
          {rows.map((row, i) => {
            const isUnknownSquad = !!row.squadId && !squads.some((s) => s.id === row.squadId)
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onInput={(e) => updateRow(i, { key: e.currentTarget.value })}
                    placeholder={meta.overrideIdField.placeholder}
                    aria-label={meta.overrideIdField.label}
                    className="ficus-field flex-1 min-w-0 text-sm bg-surface-secondary border border-th-border rounded px-2 py-1 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
                  />
                  <div className="flex-1 min-w-0">
                    <SquadDropdown
                      value={row.squadId || null}
                      squads={squads}
                      onChange={(id) => updateRow(i, { squadId: id ?? '' })}
                      placeholder="Select a squad…"
                      ariaLabel={`Squad override ${i + 1} target squad`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label={`Remove override row ${i + 1}`}
                    className="ficus-button text-xs text-muted hover:text-status-danger-600 dark:hover:text-status-danger-400 px-1 shrink-0"
                  >
                    ✕
                  </button>
                </div>
                {invalidIdx.has(i) && (
                  <p className="text-xs text-status-attention-600 dark:text-status-attention-400">
                    Fill in both the {meta.overrideIdField.label.toLowerCase()} and a squad, or remove this row.
                  </p>
                )}
                {isUnknownSquad && (
                  <p className="text-xs text-status-attention-600 dark:text-status-attention-400">
                    This override points at a squad that no longer exists ({row.squadId}). Pick a new squad or remove
                    the row.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
      <button
        type="button"
        onClick={addRow}
        className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium"
      >
        + Add override
      </button>
    </div>
  )
}

// ============================================================================
// Add / Edit forms
// ============================================================================

export function AddChannelForm({
  onClose,
  onCreated,
  initialProvider,
}: {
  onClose: () => void
  onCreated: () => void
  initialProvider?: ProviderId
}) {
  const queryClient = useQueryClient()
  const { createChannelInstance } = useChannelApi()
  const [provider, setProvider] = useState<ProviderId | null>(initialProvider ?? null)
  const [channelId, setChannelId] = useState(() => (initialProvider ? generateChannelId(initialProvider) : ''))
  const [name, setName] = useState('')
  const [providerConfigValue, setProviderConfigValue] = useState('')
  const [defaultSquadId, setDefaultSquadId] = useState<string | null>(null)
  const [overrideRows, setOverrideRows] = useState<OverrideRow[]>([])
  const [trustedChannels, setTrustedChannels] = useState<string[]>([])
  const [validationError, setValidationError] = useState('')
  const [createAttempted, setCreateAttempted] = useState(false)

  const createMutation = useMutation({
    mutationFn: (data: Partial<ChannelInstanceConfig> & { id: string; name: string; provider: string }) =>
      createChannelInstance(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
      onCreated()
    },
  })

  const handleSelectProvider = (p: ProviderId) => {
    setProvider(p)
    setChannelId(generateChannelId(p))
    setProviderConfigValue('')
  }

  const handleCreate = () => {
    if (!provider) return
    setValidationError('')
    setCreateAttempted(true)
    if (!defaultSquadId) return
    if (!name.trim()) {
      setValidationError('Name is required')
      return
    }
    if (invalidOverrideRowIndexes(overrideRows).length > 0) {
      setValidationError('Fill in both fields of each squad override below, or remove the incomplete row.')
      return
    }

    createMutation.mutate({
      id: channelId,
      name,
      provider,
      providerConfig: buildProviderConfig(provider, providerConfigValue),
      defaultSquadId,
      trustedChannelIds: trustedChannels.map((id) => id.trim()),
      channelSquadMap: overrideRowsToMap(overrideRows),
    })
  }

  return (
    <div className="border border-accent/50 rounded-lg p-4 bg-surface space-y-4">
      <div>
        <h4 className="text-sm font-medium text-primary mb-1">New Channel</h4>
        <p className="text-xs text-muted">
          A channel connects a Discord, Slack, or Telegram bot to tau. Messages that arrive through it are handled by
          agents in your default squad — unless you add a squad override below to route a specific provider channel to a
          different squad instead.
        </p>
      </div>

      {!initialProvider && <ProviderPicker value={provider} onChange={handleSelectProvider} />}

      {provider && (
        <div className="space-y-3">
          <div>
            <FormField label="Name" value={name} onChange={setName} placeholder="e.g. Acme Discord" />
            <p className="text-xs text-muted mt-1">
              Shown in the channels list below — pick something you'll recognize.
            </p>
          </div>
          <ProviderConfigField provider={provider} value={providerConfigValue} onChange={setProviderConfigValue} />
          <DefaultSquadField defaultSquadId={defaultSquadId} onChange={setDefaultSquadId} showError={createAttempted} />
          <SquadOverridesEditor provider={provider} rows={overrideRows} onChange={setOverrideRows} />
          <TrustedChannelsField value={trustedChannels} onChange={setTrustedChannels} />
          <p className="text-xs text-muted font-mono">ID: {channelId}</p>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2 flex-wrap">
        <button
          onClick={handleCreate}
          disabled={!provider || createMutation.isPending}
          className="ficus-button ficus-button-primary text-sm bg-accent text-on-accent px-4 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating…' : 'Create'}
        </button>
        <button onClick={onClose} className="ficus-button text-sm text-muted hover:text-primary px-3 py-1.5">
          Cancel
        </button>
        {validationError && (
          <span className="text-xs text-status-danger-600 dark:text-status-danger-400">{validationError}</span>
        )}
        {createMutation.isError && (
          <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
            {(createMutation.error as Error).message}
          </span>
        )}
      </div>
    </div>
  )
}

export function ChannelRow({
  channel,
  isExpanded,
  onToggle,
  onShowDiff,
  canUpdate,
  canDelete,
}: {
  channel: ChannelInstanceConfig
  isExpanded: boolean
  onToggle: () => void
  onShowDiff: () => void
  canUpdate: boolean
  canDelete: boolean
}) {
  const queryClient = useQueryClient()
  const {
    updateChannelInstance,
    deleteChannelInstance,
    enableChannelInstance,
    disableChannelInstance,
    revertChannelInstanceFields,
    exportChannelInstanceYaml,
  } = useChannelApi()
  const [form, setForm] = useState(() => channelToForm(channel))
  const [copyMsg, setCopyMsg] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saveAttempted, setSaveAttempted] = useState(false)
  const panelId = useId()

  useEffect(() => {
    setForm(channelToForm(channel))
    setSaveAttempted(false)
  }, [channel])

  const updateMutation = useMutation({
    mutationFn: (data: Partial<ChannelInstanceConfig>) => updateChannelInstance(channel.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteChannelInstance(channel.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
    },
  })

  const toggleDisableMutation = useMutation({
    mutationFn: () => (channel.disabled ? enableChannelInstance(channel.id) : disableChannelInstance(channel.id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
    },
  })

  const fieldDiffQuery = useQuery({
    ...queries.channelInstances.templateDiff(channel.id),
    enabled: isExpanded && channel.hasTemplate,
  })

  const revertFieldMutation = useMutation({
    mutationFn: (field: string) => revertChannelInstanceFields(channel.id, [field]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.channelInstances.templateDiff(channel.id) })
    },
  })

  const fieldActions = (field: string) => (
    <TemplateFieldActions
      field={field}
      current={fieldDiffQuery.data?.current ?? null}
      template={fieldDiffQuery.data?.template ?? null}
      fieldOverrides={fieldDiffQuery.data?.fieldOverrides ?? channel.yamlFieldOverrides}
      onRevert={(field) => canUpdate && revertFieldMutation.mutate(field)}
      isReverting={revertFieldMutation.isPending}
    />
  )

  const handleSave = () => {
    if (!canUpdate) return
    setSaveError('')
    setSaveAttempted(true)
    if (!form.defaultSquadId) return
    if (invalidOverrideRowIndexes(form.overrideRows).length > 0) {
      setSaveError('Fill in both fields of each squad override below, or remove the incomplete row.')
      return
    }

    updateMutation.mutate({
      name: form.name,
      providerConfig: buildProviderConfig(channel.provider, form.providerConfigValue),
      trustedChannelIds: form.trustedChannels.map((id) => id.trim()),
      channelSquadMap: overrideRowsToMap(form.overrideRows),
      defaultSquadId: form.defaultSquadId,
    })
  }

  const handleExport = async () => {
    try {
      const yaml = await exportChannelInstanceYaml(channel.id)
      await navigator.clipboard.writeText(yaml)
      setCopyMsg('Copied!')
      setTimeout(() => setCopyMsg(''), 2000)
    } catch {
      setCopyMsg('Failed')
      setTimeout(() => setCopyMsg(''), 2000)
    }
  }

  const handleDelete = () => {
    if (window.confirm(`Delete channel "${channel.name}"? This cannot be undone.`)) {
      deleteMutation.mutate()
    }
  }

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className="ficus-button w-full text-left flex items-start gap-2"
        onClick={onToggle}
      >
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-primary">{channel.name}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary text-muted">
              {getProviderMeta(channel.provider).label}
            </span>
            {!channel.defaultSquadId && (
              <span className="text-xs font-medium text-status-attention-700 dark:text-status-attention-400">
                Needs configuration
              </span>
            )}
            {channel.disabled && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-neutral-100 dark:bg-status-neutral-800 text-status-neutral-600 dark:text-status-neutral-400">
                Disabled
              </span>
            )}
            {channel.yamlFieldOverrides.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-review-100 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-400">
                Modified
              </span>
            )}
          </span>
          <span className="block text-xs text-muted font-mono mt-0.5">{channel.id}</span>
        </span>
        <span aria-hidden="true" className="text-muted text-xs shrink-0">
          {isExpanded ? '▼' : '▶'}
        </span>
      </button>

      {isExpanded && (
        <div id={panelId} className="mt-3 space-y-3">
          {!channel.defaultSquadId && (
            <p role="status" className="text-sm text-status-attention-700 dark:text-status-attention-400">
              New conversations without a matching override cannot be routed. Existing conversations may continue with
              their current squad.{' '}
              {canUpdate ? 'Select a Default Squad below and save.' : 'Ask an administrator to select a Default Squad.'}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {channel.hasTemplate && channel.yamlFieldOverrides.length > 0 && (
              <button
                onClick={onShowDiff}
                className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium"
              >
                Compare to Template
              </button>
            )}
            <button
              onClick={handleExport}
              className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium"
            >
              {copyMsg || 'Export YAML'}
            </button>
            {canUpdate && (
              <button
                onClick={() => toggleDisableMutation.mutate()}
                disabled={toggleDisableMutation.isPending}
                className="ficus-button text-xs text-status-attention-600 dark:text-status-attention-400 hover:text-status-attention-800 dark:hover:text-status-attention-300 font-medium"
              >
                {channel.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
            {canDelete && !channel.hasTemplate && (
              <button
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium"
              >
                Delete
              </button>
            )}
          </div>

          <div className="space-y-2">
            <FormField
              label="Name"
              value={form.name}
              onChange={(v) => canUpdate && setForm({ ...form, name: v })}
              actions={canUpdate ? fieldActions('name') : null}
            />
            <FormField
              label="Provider"
              value={getProviderMeta(channel.provider).label}
              onChange={() => {}}
              readOnly
              actions={fieldActions('provider')}
            />
            <ProviderConfigField
              provider={channel.provider}
              value={form.providerConfigValue}
              onChange={(v) => setForm({ ...form, providerConfigValue: v })}
              actions={fieldActions('providerConfig')}
            />
            <DefaultSquadField
              defaultSquadId={form.defaultSquadId}
              showError={saveAttempted}
              onChange={(id) => setForm({ ...form, defaultSquadId: id })}
              actions={fieldActions('defaultSquadId')}
            />
            <SquadOverridesEditor
              provider={channel.provider}
              rows={form.overrideRows}
              onChange={(rows) => setForm({ ...form, overrideRows: rows })}
              actions={fieldActions('channelSquadMap')}
            />

            <TrustedChannelsField
              value={form.trustedChannels}
              onChange={(value) => canUpdate && setForm({ ...form, trustedChannels: value })}
              actions={fieldActions('trustedChannelIds')}
            />
            <div className="flex items-center gap-2 pt-2 flex-wrap">
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
              {saveError && (
                <span className="text-xs text-status-danger-600 dark:text-status-danger-400">{saveError}</span>
              )}
              {updateMutation.isError && (
                <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
                  {(updateMutation.error as Error).message}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Helpers
// ============================================================================

function FormField({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
  actions,
}: {
  label: string
  value: string
  onChange: (v: string) => void
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
      <input
        type="text"
        value={value}
        onInput={(e) => onChange(e.currentTarget.value)}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-label={label}
        className={clsx('ficus-field', cls, readOnly && 'opacity-60')}
      />
    </div>
  )
}

function channelToForm(ch: ChannelInstanceConfig) {
  return {
    trustedChannels: ch.trustedChannelIds ?? [],
    name: ch.name,
    providerConfigValue: extractProviderConfigValue(ch.provider, ch.providerConfig),
    defaultSquadId: ch.defaultSquadId ?? null,
    overrideRows: mapToOverrideRows(ch.channelSquadMap),
  }
}

export function TrustedChannelsField({
  value,
  onChange,
  actions,
}: {
  value: string[]
  onChange: (value: string[]) => void
  actions?: ReactNode
}) {
  return (
    <ChannelIdsEditor kind="Trusted" value={value} onChange={onChange} actions={actions}>
      By default, senders must link a Ficus account with squad chat access. Everyone who can message Ficus in a trusted
      channel can direct its squad’s agents, including through the manager. Add only channels whose participants you
      trust. Leave empty to require linked users everywhere.
    </ChannelIdsEditor>
  )
}
