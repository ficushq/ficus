import type { PendingAction } from '@ficus/shared'

/**
 * The squad a pending action belongs to: the server sets the top-level `squadId` when the
 * action has one, and every action payload also carries its own (nullable) `squadId`.
 * Returns null for account-level actions with no squad, such as a squad-less Assistant task.
 */
export function pendingActionSquadId(action: PendingAction): string | null {
  if (action.squadId) return action.squadId
  const data = action.data as { squadId?: string | null } | undefined
  return data?.squadId ?? null
}

/**
 * Applies the Feed's squad filter to pending actions for display. An empty selection is
 * "All squads" and keeps every action. With a selection, only actions that belong to a
 * selected squad remain; actions without a squad are hidden, as they belong to no selected squad.
 */
export function filterPendingActionsBySquads(actions: PendingAction[], squadIds: readonly string[]): PendingAction[] {
  if (squadIds.length === 0) return actions
  const selected = new Set(squadIds)
  return actions.filter((action) => {
    const squadId = pendingActionSquadId(action)
    return squadId !== null && selected.has(squadId)
  })
}
