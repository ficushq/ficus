import { describe, expect, test } from 'bun:test'
import type { PendingAction } from '@ficus/shared'
import { filterPendingActionsBySquads, pendingActionSquadId } from './pendingActionSquads'

function action(id: string, squadId: string | undefined, dataSquadId: string | null): PendingAction {
  return {
    id,
    type: 'assistant-needs-input',
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    canRespond: true,
    ...(squadId ? { squadId } : {}),
    data: { squadId: dataSquadId } as PendingAction['data'],
  } as PendingAction
}

describe('pendingActionSquadId', () => {
  test('prefers the top-level squad and falls back to the action payload', () => {
    expect(pendingActionSquadId(action('a', 'squad-1', 'squad-1'))).toBe('squad-1')
    expect(pendingActionSquadId(action('b', undefined, 'squad-2'))).toBe('squad-2')
    expect(pendingActionSquadId(action('c', undefined, null))).toBeNull()
  })
})

describe('filterPendingActionsBySquads', () => {
  const actions = [
    action('ficus', 'squad-1', 'squad-1'),
    action('source', undefined, 'squad-2'),
    action('account', undefined, null),
  ]

  test('keeps every action, including squad-less ones, for All squads', () => {
    expect(filterPendingActionsBySquads(actions, [])).toBe(actions)
  })

  test('keeps only actions in a selected squad and hides squad-less actions', () => {
    expect(filterPendingActionsBySquads(actions, ['squad-1']).map((a) => a.id)).toEqual(['ficus'])
    expect(filterPendingActionsBySquads(actions, ['squad-1', 'squad-2']).map((a) => a.id)).toEqual(['ficus', 'source'])
    expect(filterPendingActionsBySquads(actions, ['squad-3'])).toEqual([])
  })
})
