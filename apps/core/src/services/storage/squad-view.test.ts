import { describe, expect, test } from 'bun:test'
import type { StorageFolder, StorageMachine, StorageSnapshot } from '@ficus/shared'
import type { Machine } from '../machines/queries'
import type { StorageOwner } from './accounting'
import type { StorageTarget } from './index'
import { projectSquadStorage, scopeStorageTargets } from './squad-view'

const machine = (id: string) => ({ id, name: `host-${id}`, status: 'ready' }) as Machine
const owner = (home: string, squadId: string, kind: StorageOwner['kind'] = 'agent'): StorageOwner => ({
  home,
  squadId,
  squadName: `Squad ${squadId}`,
  label: home,
  kind,
})
const folder = (path: string, bytes: number | null, measuredAt?: string): StorageFolder => ({
  name: path,
  path,
  bytes,
  status: bytes === null ? 'unavailable' : 'available',
  children: [],
  ...(measuredAt ? { measuredAt } : {}),
})

describe('scopeStorageTargets', () => {
  test('keeps only the squad’s owners and drops machines without any of them', () => {
    const targets: StorageTarget[] = [
      {
        machine: machine('a'),
        owners: [owner('/home/box_own1', 'own', 'squad-workspace'), owner('/home/box_oth1', 'other')],
      },
      { machine: machine('b'), owners: [owner('/home/box_oth2', 'other')] },
      { machine: machine('c'), owners: [owner('/home/box_own2', 'own')] },
    ]
    const scoped = scopeStorageTargets(targets, 'own')
    expect(scoped.map((target) => target.machine.id)).toEqual(['a', 'c'])
    expect(scoped.flatMap((target) => target.owners.map((item) => item.home))).toEqual([
      '/home/box_own1',
      '/home/box_own2',
    ])
    expect(scopeStorageTargets(targets, 'missing')).toEqual([])
  })
})

describe('projectSquadStorage', () => {
  const hostOnly: StorageMachine = {
    id: 'b',
    name: 'host-b',
    status: 'available',
    usedBytes: 123_456_789,
    totalBytes: 987_654_321,
    unattributedBytes: 55_555,
    squads: [
      { id: 'other', name: 'Other', bytes: 4_000, status: 'available', folders: [folder('/home/box_oth2', 4_000)] },
    ],
  }
  const shared: StorageMachine = {
    id: 'a',
    name: 'host-a',
    status: 'partial',
    usedBytes: 111_111_111,
    totalBytes: 999_999_999,
    unattributedBytes: 77_777,
    diskMeasuredAt: '2026-10-30T10:00:00.000Z',
    diskGrowth: { bytes: 31_337, since: '2026-10-29T10:00:00.000Z' },
    scan: {
      state: 'running',
      generation: 4,
      passStartedAt: '2026-10-30T09:00:00.000Z',
      lastCompletedAt: '2026-10-30T08:00:00.000Z',
      measuredHomes: 17,
      totalHomes: 42,
    },
    diagnostics: {
      exitCode: null,
      reasons: ['missing_home_totals'],
      expectedHomes: 42,
      measuredHomes: 41,
      missingHomes: ['/home/box_oth9'],
    },
    squads: [
      {
        id: 'other',
        name: 'Other',
        bytes: 9_000,
        status: 'available',
        folders: [folder('/home/box_oth1', 9_000, '2026-10-30T11:00:00.000Z')],
      },
      {
        id: 'own',
        name: 'Own',
        bytes: 300,
        status: 'available',
        growth: { bytes: 20, since: '2026-10-29T10:00:00.000Z' },
        folders: [
          folder('/home/box_own1', 200, '2026-10-30T10:30:00.000Z'),
          folder('/home/box_own2', 100, '2026-10-30T09:15:00.000Z'),
        ],
      },
    ],
  }
  const unscoped: Pick<StorageSnapshot, 'machines'> = { machines: [hostOnly, shared] }

  test('copies only the squad’s entry, the machine identity and scan timing', () => {
    const view = projectSquadStorage(unscoped, 'own')
    expect(view).toEqual({
      bytes: 300,
      scannedAt: '2026-10-30T10:30:00.000Z',
      oldestMeasuredAt: '2026-10-30T09:15:00.000Z',
      machines: [
        {
          id: 'a',
          name: 'host-a',
          storage: shared.squads[1]!,
          scan: {
            state: 'running',
            generation: 4,
            passStartedAt: '2026-10-30T09:00:00.000Z',
            lastCompletedAt: '2026-10-30T08:00:00.000Z',
          },
        },
      ],
    })
    // Nothing instance-wide or from another squad survives, even from an unscoped snapshot.
    const text = JSON.stringify(view)
    for (const leaked of [
      'box_oth',
      'other',
      'Other',
      'host-b',
      '111111111',
      '999999999',
      '77777',
      '31337',
      '"measuredHomes"',
      '"totalHomes"',
      'missingHomes',
      'usedBytes',
      'totalBytes',
      'unattributedBytes',
      'diagnostics',
    ])
      expect(text).not.toContain(leaked)
  })

  test('returns a copy, so later changes to the snapshot cannot alter the view', () => {
    const view = projectSquadStorage(unscoped, 'own')
    view.machines[0]!.storage.folders.pop()
    expect(shared.squads[1]!.folders).toHaveLength(2)
  })

  test('reports unmeasured squads as null, never zero', () => {
    const unmeasured: StorageMachine = {
      ...hostOnly,
      squads: [
        { id: 'own', name: 'Own', bytes: null, status: 'unavailable', folders: [folder('/home/box_own3', null)] },
      ],
    }
    expect(projectSquadStorage({ machines: [unmeasured] }, 'own')).toMatchObject({
      bytes: null,
      scannedAt: null,
      oldestMeasuredAt: null,
    })
    expect(projectSquadStorage({ machines: [] }, 'own')).toEqual({
      bytes: null,
      machines: [],
      scannedAt: null,
      oldestMeasuredAt: null,
    })
  })
})
