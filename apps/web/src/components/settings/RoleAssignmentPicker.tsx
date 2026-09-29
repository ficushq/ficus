import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RoleSummary } from '../../api/roles'
import { queries } from '../../queryOptions'

export type AssignmentScope = 'system' | 'squad_default' | 'squad'

export interface RoleAssignmentInput {
  roleId: string
  scope: AssignmentScope
  squadId?: string
}

export const SCOPE_LABELS: Record<AssignmentScope, string> = {
  system: 'System',
  squad_default: 'Every squad',
  squad: 'One squad',
}

const FIELD =
  'ficus-field text-xs bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary focus:ring-1 focus:ring-accent'

/**
 * Picks one role assignment the way the per-user role editor does: a role,
 * its scope (the whole instance, every squad by default, or one squad), and
 * for one squad, which. Shared by that editor and the invite form, so both
 * offer the same steps.
 */
export function RoleAssignmentPicker({
  idPrefix,
  roles,
  onAdd,
  busy = false,
  addLabel = 'Assign',
  busyLabel = 'Assigning...',
  onPendingChange,
}: {
  idPrefix: string
  roles: RoleSummary[]
  onAdd: (assignment: RoleAssignmentInput) => void
  busy?: boolean
  addLabel?: string
  busyLabel?: string
  /** Told whether a role is picked but not yet added, so a form can hold off submitting without it. */
  onPendingChange?: (pending: boolean) => void
}) {
  const [roleId, setRoleId] = useState('')
  const [scope, setScope] = useState<AssignmentScope>('system')
  const [squadId, setSquadId] = useState('')
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), enabled: scope === 'squad' })
  const ready = !!roleId && (scope !== 'squad' || !!squadId)
  const pending = !!roleId
  useEffect(() => onPendingChange?.(pending), [onPendingChange, pending])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${idPrefix}-role`} className="sr-only">
        Role to assign
      </label>
      <select id={`${idPrefix}-role`} value={roleId} onChange={(e) => setRoleId(e.target.value)} className={FIELD}>
        <option value="">Select role...</option>
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${idPrefix}-scope`} className="sr-only">
        Assignment scope
      </label>
      <select
        id={`${idPrefix}-scope`}
        value={scope}
        onChange={(e) => setScope(e.target.value as AssignmentScope)}
        className={FIELD}
      >
        {(Object.keys(SCOPE_LABELS) as AssignmentScope[]).map((value) => (
          <option key={value} value={value}>
            {SCOPE_LABELS[value]}
          </option>
        ))}
      </select>
      {scope === 'squad' && (
        <>
          <label htmlFor={`${idPrefix}-squad`} className="sr-only">
            Squad
          </label>
          <select
            id={`${idPrefix}-squad`}
            value={squadId}
            onChange={(e) => setSquadId(e.target.value)}
            className={`${FIELD} max-w-44`}
          >
            <option value="">Select squad…</option>
            {squads.map((squad) => (
              <option key={squad.id} value={squad.id}>
                {squad.name}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        type="button"
        onClick={() => {
          onAdd({ roleId, scope, squadId: scope === 'squad' ? squadId : undefined })
          setRoleId('')
          setScope('system')
          setSquadId('')
        }}
        disabled={!ready || busy}
        className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? busyLabel : addLabel}
      </button>
    </div>
  )
}
