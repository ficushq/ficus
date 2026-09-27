import { isWorkerAgentType } from '@ficus/shared'
import { useState, useCallback, useEffect, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'

interface AgentTypeOption {
  systemOnly?: boolean
  disabled?: boolean
  id: string
  name: string
}

interface Props {
  squadId: string
  typeContext: Record<string, string> | null
  agentTypes: AgentTypeOption[]
}

function stableTypeContextKey(typeContext: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(typeContext)
      .sort()
      .map((id) => [id, typeContext[id] ?? ''])
  )
}

function activeIdsForTypeContext(typeContext: Record<string, string>, agentTypes: AgentTypeOption[]): string[] {
  const agentTypeIds = new Set(agentTypes.map((t) => t.id))
  return Object.keys(typeContext).filter((id) => agentTypeIds.has(id))
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function SquadAgentContextEditor({ squadId, typeContext, agentTypes }: Props) {
  const typeContextSnapshot = useMemo(() => stableTypeContextKey(typeContext ?? {}), [typeContext])
  const agentTypeIdsKey = useMemo(() => agentTypes.map((t) => t.id).join('\0'), [agentTypes])

  // Track which agent types have a visible field. Initialize from typeContext keys.
  const [activeIds, setActiveIds] = useState<string[]>(() => activeIdsForTypeContext(typeContext ?? {}, agentTypes))
  const [values, setValues] = useState<Record<string, string>>(typeContext ?? {})
  const [locallyRemovedIds, setLocallyRemovedIds] = useState<Set<string>>(() => new Set())
  const [syncedTypeContextSnapshot, setSyncedTypeContextSnapshot] = useState(typeContextSnapshot)
  const [saved, setSaved] = useState(false)
  const queryClient = useQueryClient()

  const currentActiveSnapshot = useMemo(() => {
    // Compare only active fields — empty fields should be treated as absent
    const currentActive: Record<string, string> = {}
    for (const id of activeIds) {
      const val = values[id] ?? ''
      if (val.trim()) currentActive[id] = val
    }
    return stableTypeContextKey(currentActive)
  }, [values, activeIds])

  // Sync from server state only when the saved type context changes semantically.
  // Periodic query refreshes can produce new prop object/array identities with the
  // same saved values; those should not overwrite local dirty edits.
  useEffect(() => {
    if (typeContextSnapshot === syncedTypeContextSnapshot) return

    if (currentActiveSnapshot !== syncedTypeContextSnapshot) {
      setSyncedTypeContextSnapshot(typeContextSnapshot)
      return
    }

    const tc = typeContext ?? {}
    setValues(tc)
    setActiveIds(activeIdsForTypeContext(tc, agentTypes))
    setLocallyRemovedIds(new Set())
    setSyncedTypeContextSnapshot(typeContextSnapshot)
  }, [agentTypes, currentActiveSnapshot, syncedTypeContextSnapshot, typeContext, typeContextSnapshot])

  // If the agent type list changes (for example, it loads after the context),
  // reconcile visible rows without touching the textarea values.
  useEffect(() => {
    const agentTypeIds = new Set(agentTypes.map((t) => t.id))
    const savedActiveIds = activeIdsForTypeContext(typeContext ?? {}, agentTypes)

    setActiveIds((ids) => {
      const next = ids.filter((id) => agentTypeIds.has(id))
      for (const id of savedActiveIds) {
        if (!locallyRemovedIds.has(id) && !next.includes(id)) next.push(id)
      }
      return areStringArraysEqual(next, ids) ? ids : next
    })
  }, [agentTypeIdsKey, agentTypes, locallyRemovedIds, typeContext, typeContextSnapshot])

  const dirty = currentActiveSnapshot !== typeContextSnapshot

  const mutation = useMutation({
    mutationFn: (next: Record<string, string>) =>
      updateSquad(squadId, {
        typeContext: Object.values(next).some((v) => v.trim()) ? next : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const handleSave = useCallback(() => {
    // Only send non-empty values from active fields
    const toSave: Record<string, string> = {}
    for (const id of activeIds) {
      const val = values[id] ?? ''
      if (val.trim()) toSave[id] = val
    }
    mutation.mutate(toSave)
  }, [values, activeIds, mutation])

  const handleAddType = useCallback(
    (typeId: string) => {
      if (!typeId || activeIds.includes(typeId)) return
      setActiveIds((ids) => [...ids, typeId])
      setValues((v) => ({ ...v, [typeId]: v[typeId] ?? '' }))
      setLocallyRemovedIds((ids) => {
        if (!ids.has(typeId)) return ids
        const next = new Set(ids)
        next.delete(typeId)
        return next
      })
    },
    [activeIds]
  )

  const handleRemoveType = useCallback((typeId: string) => {
    setActiveIds((ids) => ids.filter((id) => id !== typeId))
    setLocallyRemovedIds((ids) => new Set(ids).add(typeId))
  }, [])

  const handleValueChange = useCallback((typeId: string, value: string) => {
    setValues((v) => ({ ...v, [typeId]: value }))
  }, [])

  const agentTypeMap = useMemo(() => {
    const map = new Map<string, AgentTypeOption>()
    for (const t of agentTypes) map.set(t.id, t)
    return map
  }, [agentTypes])

  // Types that don't have a field yet — available for the picker.
  // Managers have squad-owned context too; other reserved system agents do not.
  const availableTypes = useMemo(
    () =>
      agentTypes.filter(
        (t) => !activeIds.includes(t.id) && (isWorkerAgentType(t) || (t.id === 'manager' && !t.disabled))
      ),
    [agentTypes, activeIds]
  )

  if (agentTypes.length === 0) {
    return <p className="text-xs text-muted">No agent types available.</p>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 data-setting-target="type-specific-context" className="text-sm font-medium text-primary">
          Type-Specific Context
        </h3>
        <p className="text-xs text-muted mt-1">
          Custom instructions injected into agents of each type, in addition to the global squad context above.
        </p>
      </div>
      {activeIds.map((typeId) => {
        const t = agentTypeMap.get(typeId)
        const name = t?.name ?? typeId
        return (
          <div key={typeId} className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-secondary">{name}</label>
              <button
                onClick={() => handleRemoveType(typeId)}
                className="ficus-button text-xs text-muted hover:text-status-danger-500 transition-colors"
                aria-label={`Remove ${name} context field`}
              >
                ✕
              </button>
            </div>
            <textarea
              value={values[typeId] ?? ''}
              onInput={(e) => handleValueChange(typeId, e.currentTarget.value)}
              placeholder={`Instructions for ${name} agents...`}
              className={clsx(
                'ficus-field',
                'w-full h-32 p-2.5 rounded-lg border bg-surface text-primary text-sm',
                'font-mono leading-relaxed resize-y placeholder:text-placeholder',
                ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                'border-th-border'
              )}
            />
          </div>
        )
      })}
      {availableTypes.length > 0 && (
        <div>
          <select
            value=""
            onChange={(e) => {
              handleAddType(e.target.value)
            }}
            className={clsx(
              'ficus-field',
              'w-full px-3 py-1.5 text-sm rounded-md border bg-surface text-muted',
              ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
              'border-th-border'
            )}
          >
            <option value="">+ Add agent type...</option>
            {availableTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : saved ? '✓ Saved' : ''}</span>
        <button
          onClick={handleSave}
          disabled={!dirty || mutation.isPending}
          className={clsx(
            'ficus-button',
            'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
            dirty ? 'bg-accent text-on-accent hover:bg-accent/90' : 'bg-surface-secondary text-muted cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
      {mutation.isError && <p className="text-xs text-status-danger-500">Failed to save: {String(mutation.error)}</p>}
    </div>
  )
}
