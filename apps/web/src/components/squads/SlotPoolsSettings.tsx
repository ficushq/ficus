import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  MAX_SLOT_USAGE_LENGTH,
  registerSlotPool,
  unregisterSlotPool,
  updateSlotPool,
  type SlotPool,
  type UpdateSlotPoolInput,
} from '../../api/slots'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { actionErrorMessage } from '../../lib/actionError'
import { Badge } from '../Badge'
import { ConfirmButton } from '../ConfirmButton'
import { CollectionSkeleton } from '../loading/Skeleton'
import {
  formatSlotAge,
  formatSlotTimeout,
  normalizeSlotKey,
  normalizeSlotUsage,
  parseSlotCapacity,
  parseSlotTimeout,
  slotCapacityError,
  slotKeyError,
  slotTimeoutError,
  slotUsageError,
} from './slotPoolForm'

interface Props {
  squadId: string
}

const FIELD_CLASS = clsx(
  'ficus-field',
  'w-full px-3 py-2 text-sm rounded-md border bg-surface text-primary',
  'placeholder:text-placeholder',
  'focus:ring-2 focus:ring-accent/50 focus:border-accent'
)

function fieldClass(error: string | null, extra?: string) {
  return clsx(FIELD_CLASS, error ? 'border-status-danger-500' : 'border-th-border', extra)
}

/**
 * Squad Settings → Instructions card for slot pools: cooperative capacity
 * admission agents claim before protected work. Lists each pool's
 * configuration, usage guidance and live usage; slots:write can register,
 * edit, disable/enable and unregister. Live usage refreshes through the squad
 * `slots.updated` event (the query lives under `queryKeys.squads`).
 */
export function SlotPoolsSettings({ squadId }: Props) {
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions(squadId)
  const canWrite = !permissionsLoading && can('slots:write')
  const canRead = !permissionsLoading && !permissionsError && (canWrite || can('slots:use'))
  const [showAddForm, setShowAddForm] = useState(false)

  const poolsQuery = useQuery({ ...queries.squads.slotPools(squadId), enabled: canRead })
  const pools = poolsQuery.data ?? []
  const skeletonCount = useLoadingShapeCount(
    `squads:${squadId}:slot-pools`,
    poolsQuery.isSuccess ? pools.length : undefined,
    { fallbackCount: 2, maxCount: 6 }
  )
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.squads.slotPools(squadId) })

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 data-setting-target="slot-pools" className="text-sm font-medium text-primary">
            Slot Pools
          </h3>
          <p className="text-xs text-muted mt-1">
            Capacity pools agents claim before work that must not run too many times at once, such as heavy tests or
            production changes. Each pool's usage guidance is automatically included in every agent's prompt as a "Slot
            Pools" section, so there is no need to repeat it in the context above.
          </p>
        </div>
        {canWrite && !showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md font-medium shrink-0"
          >
            Add Pool
          </button>
        )}
      </div>

      {canWrite && showAddForm && (
        <AddSlotPoolForm
          squadId={squadId}
          onDone={() => {
            setShowAddForm(false)
            void invalidate()
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {permissionsLoading ? (
        <CollectionSkeleton label="Loading slot pools" count={skeletonCount} />
      ) : !canRead ? (
        <div className="text-sm text-muted py-4 text-center border border-dashed border-th-border rounded-lg">
          You don't have permission to view slot pools in this squad.
        </div>
      ) : poolsQuery.isLoading ? (
        <CollectionSkeleton label="Loading slot pools" count={skeletonCount} />
      ) : poolsQuery.isError ? (
        <p className="text-xs text-status-danger-500">
          Failed to load slot pools: {actionErrorMessage(poolsQuery.error)}
        </p>
      ) : pools.length === 0 ? (
        <div className="text-sm text-muted py-4 text-center border border-dashed border-th-border rounded-lg">
          No slot pools registered.
        </div>
      ) : (
        <div className="ficus-inset">
          {pools.map((pool) => (
            <SlotPoolRow key={pool.id} squadId={squadId} pool={pool} canWrite={canWrite} onChanged={invalidate} />
          ))}
        </div>
      )}
    </div>
  )
}

function AddSlotPoolForm({ squadId, onDone, onCancel }: { squadId: string; onDone: () => void; onCancel: () => void }) {
  const [key, setKey] = useState('')
  const [capacity, setCapacity] = useState('1')
  const [timeout, setTimeoutValue] = useState('1h')
  const [usage, setUsage] = useState('')
  const [touchedKey, setTouchedKey] = useState(false)

  const keyError = slotKeyError(key)
  const capacityError = slotCapacityError(capacity)
  const timeoutError = slotTimeoutError(timeout)
  const usageError = slotUsageError(usage)
  const valid = !keyError && !capacityError && !timeoutError && !usageError

  const mutation = useMutation({
    mutationFn: () =>
      registerSlotPool(squadId, {
        key: normalizeSlotKey(key),
        capacity: parseSlotCapacity(capacity)!,
        claimTimeoutMs: parseSlotTimeout(timeout)!,
        usage: normalizeSlotUsage(usage),
      }),
    onSuccess: onDone,
  })

  return (
    <form
      className="ficus-inset p-4 mb-4"
      onSubmit={(event) => {
        event.preventDefault()
        setTouchedKey(true)
        if (valid) mutation.mutate()
      }}
    >
      <h4 className="text-sm font-medium text-primary mb-3">Add Slot Pool</h4>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex-1 block">
            <span className="block text-xs font-medium text-secondary mb-1">Key</span>
            <input
              type="text"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onBlur={() => setTouchedKey(true)}
              placeholder="shared-box-intensive"
              className={fieldClass(touchedKey ? keyError : null, 'font-mono')}
            />
            {touchedKey && keyError && <span className="block text-xs text-status-danger-500 mt-1">{keyError}</span>}
          </label>
          <PoolNumberFields
            capacity={capacity}
            timeout={timeout}
            onCapacity={setCapacity}
            onTimeout={setTimeoutValue}
            capacityError={capacityError}
            timeoutError={timeoutError}
          />
        </div>
        <UsageField value={usage} onChange={setUsage} error={usageError} />
      </div>
      <div className="flex items-center justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md font-medium"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || mutation.isPending}
          className={clsx(
            'ficus-button ficus-button-primary px-4 py-1.5 text-sm rounded-md font-medium',
            !valid && 'opacity-50 cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Adding...' : 'Add Pool'}
        </button>
      </div>
      {mutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to add pool: {actionErrorMessage(mutation.error)}</p>
      )}
    </form>
  )
}

function PoolNumberFields(props: {
  capacity: string
  timeout: string
  onCapacity: (value: string) => void
  onTimeout: (value: string) => void
  capacityError: string | null
  timeoutError: string | null
}) {
  return (
    <>
      <label className="sm:w-28 block">
        <span className="block text-xs font-medium text-secondary mb-1">Capacity</span>
        <input
          type="text"
          inputMode="numeric"
          value={props.capacity}
          onChange={(event) => props.onCapacity(event.target.value)}
          className={fieldClass(props.capacityError)}
        />
        {props.capacityError && (
          <span className="block text-xs text-status-danger-500 mt-1">{props.capacityError}</span>
        )}
      </label>
      <label className="sm:w-36 block">
        <span className="block text-xs font-medium text-secondary mb-1">Claim timeout</span>
        <input
          type="text"
          value={props.timeout}
          onChange={(event) => props.onTimeout(event.target.value)}
          placeholder="45m"
          className={fieldClass(props.timeoutError)}
        />
        {props.timeoutError && <span className="block text-xs text-status-danger-500 mt-1">{props.timeoutError}</span>}
      </label>
    </>
  )
}

function UsageField({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error: string | null
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs font-medium text-secondary mb-1">
        <span>Usage guidance (optional)</span>
        <span className={clsx('font-normal', error ? 'text-status-danger-500' : 'text-muted')}>
          {value.trim().length}/{MAX_SLOT_USAGE_LENGTH}
        </span>
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        placeholder="What this pool protects and when agents should claim and release it."
        className={fieldClass(error, 'resize-y leading-relaxed')}
      />
      {error && <span className="block text-xs text-status-danger-500 mt-1">{error}</span>}
    </label>
  )
}

function SlotPoolRow({
  squadId,
  pool,
  canWrite,
  onChanged,
}: {
  squadId: string
  pool: SlotPool
  canWrite: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const { slugFor } = useSquadSlugs()

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => updateSlotPool(squadId, pool.key, { enabled }),
    onSuccess: onChanged,
  })
  const unregisterMutation = useMutation({
    mutationFn: () => unregisterSlotPool(squadId, pool.key),
    onSuccess: onChanged,
  })
  const actionError = toggleMutation.error ?? unregisterMutation.error

  return (
    <div className="border-b border-panel-border last:border-b-0 p-3 space-y-2" data-testid={`slot-pool-${pool.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium font-mono text-primary">{pool.key}</span>
            {!pool.enabled && <Badge color="neutral">Disabled</Badge>}
          </div>
          <p className="text-xs text-muted mt-0.5">
            Capacity {pool.capacity} · Claim timeout {formatSlotTimeout(pool.claimTimeoutMs)}
          </p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2 shrink-0">
            <EnabledSwitch
              poolKey={pool.key}
              enabled={pool.enabled}
              disabled={toggleMutation.isPending}
              onChange={(enabled) => toggleMutation.mutate(enabled)}
            />
            {!editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="ficus-button ficus-button-secondary px-2 py-1 text-xs rounded"
              >
                Edit
              </button>
            )}
            <ConfirmButton
              onConfirm={() => unregisterMutation.mutate()}
              label="Unregister"
              confirmLabel="Unregister?"
              ariaLabel={`Unregister slot pool ${pool.key}`}
              disabled={unregisterMutation.isPending}
            />
          </div>
        )}
      </div>

      {editing ? (
        <EditSlotPoolForm
          squadId={squadId}
          pool={pool}
          onDone={() => {
            setEditing(false)
            onChanged()
          }}
          onCancel={() => setEditing(false)}
        />
      ) : pool.usage ? (
        <p className="text-sm text-secondary whitespace-pre-wrap">{pool.usage}</p>
      ) : (
        <p className="text-xs text-muted italic">No usage guidance.</p>
      )}

      <div className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-1">
        <span>
          {pool.activeCount}/{pool.capacity} in use
        </span>
        <span>{pool.queuedCount} queued</span>
        {pool.oldestWaiterAgeMs !== null && <span>Oldest wait {formatSlotAge(pool.oldestWaiterAgeMs)}</span>}
        {!pool.enabled && <span>Not enforced: claims are not queued and agents are not told to claim it.</span>}
      </div>

      {pool.holders.length > 0 && (
        <div className="text-xs text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Held by</span>
          {pool.holders.map((holder) => (
            <span key={holder.id ?? `${holder.ownerShortId}-${holder.claimedAt}`} className="inline-flex gap-1">
              {holder.ownerAgentId ? (
                <Link
                  to={`/squads/${slugFor(squadId)}/agents?agent=${encodeURIComponent(holder.ownerAgentId)}`}
                  className="font-mono text-accent-light hover:underline"
                >
                  {holder.ownerShortId}
                </Link>
              ) : (
                <span className="font-mono">{holder.ownerShortId}</span>
              )}
              <span>
                until {new Date(holder.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </span>
          ))}
        </div>
      )}

      {actionError && <p className="text-xs text-status-danger-500">{actionErrorMessage(actionError)}</p>}
    </div>
  )
}

function EnabledSwitch({
  poolKey,
  enabled,
  disabled,
  onChange,
}: {
  poolKey: string
  enabled: boolean
  disabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-secondary">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? 'Disable' : 'Enable'} slot pool ${poolKey}`}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={clsx(
          'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50',
          enabled ? 'bg-accent' : 'bg-th-border'
        )}
      >
        <span
          className={clsx(
            'inline-block h-4 w-4 transform rounded-full transition-transform',
            enabled ? 'translate-x-4 bg-on-accent' : 'translate-x-0 bg-chrome-toggle-thumb'
          )}
        />
      </button>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}

function EditSlotPoolForm({
  squadId,
  pool,
  onDone,
  onCancel,
}: {
  squadId: string
  pool: SlotPool
  onDone: () => void
  onCancel: () => void
}) {
  const [capacity, setCapacity] = useState(String(pool.capacity))
  const [timeout, setTimeoutValue] = useState(formatSlotTimeout(pool.claimTimeoutMs))
  const [usage, setUsage] = useState(pool.usage ?? '')

  const capacityError = slotCapacityError(capacity)
  const timeoutError = slotTimeoutError(timeout)
  const usageError = slotUsageError(usage)
  const valid = !capacityError && !timeoutError && !usageError

  // Partial update: send only what changed so concurrent edits elsewhere survive.
  const changes: UpdateSlotPoolInput = {}
  const nextCapacity = parseSlotCapacity(capacity)
  const nextTimeout = parseSlotTimeout(timeout)
  const nextUsage = normalizeSlotUsage(usage)
  if (nextCapacity !== null && nextCapacity !== pool.capacity) changes.capacity = nextCapacity
  if (nextTimeout !== null && nextTimeout !== pool.claimTimeoutMs) changes.claimTimeoutMs = nextTimeout
  if (nextUsage !== pool.usage) changes.usage = nextUsage
  const dirty = Object.keys(changes).length > 0

  const mutation = useMutation({
    mutationFn: () => updateSlotPool(squadId, pool.key, changes),
    onSuccess: onDone,
  })

  return (
    <form
      className="space-y-3 pt-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && dirty) mutation.mutate()
      }}
    >
      <div className="flex flex-col sm:flex-row gap-3">
        <PoolNumberFields
          capacity={capacity}
          timeout={timeout}
          onCapacity={setCapacity}
          onTimeout={setTimeoutValue}
          capacityError={capacityError}
          timeoutError={timeoutError}
        />
      </div>
      <UsageField value={usage} onChange={setUsage} error={usageError} />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md font-medium"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || !dirty || mutation.isPending}
          className={clsx(
            'ficus-button ficus-button-primary px-4 py-1.5 text-sm rounded-md font-medium',
            (!valid || !dirty) && 'opacity-50 cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
      {mutation.isError && (
        <p className="text-xs text-status-danger-500">Failed to save: {actionErrorMessage(mutation.error)}</p>
      )}
    </form>
  )
}
