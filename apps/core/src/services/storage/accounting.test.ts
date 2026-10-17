import { describe, expect, test } from 'bun:test'
import { attributeStorage, buildFolderTree, type HomeView } from './accounting'

const A = '/home/box_aaaaaaaaaaaa'
const B = '/home/box_bbbbbbbbbbbb'
const C = '/home/box_cccccccccccc'
const view = (home: string, entries: Array<[string, number]>, partial: string[] = []): HomeView => ({
  folder: buildFolderTree(home, new Map(entries), new Set(partial)),
})

describe('folder trees', () => {
  test('builds inclusive nested totals, largest first', () => {
    const tree = buildFolderTree(
      A,
      new Map([
        [`${A}/workspace/repos/project`, 100],
        [`${A}/workspace/repos`, 100],
        [`${A}/workspace/tmp`, 40],
        [`${A}/workspace`, 150],
        [A, 200],
      ])
    )
    expect(tree).toMatchObject({ path: A, bytes: 200, status: 'available' })
    expect(tree.children[0]!.children.map((child) => [child.name, child.bytes])).toEqual([
      ['repos', 100],
      ['tmp', 40],
    ])
    expect(tree.children[0]!.children[0]!.children[0]).toEqual({
      name: 'project',
      path: `${A}/workspace/repos/project`,
      bytes: 100,
      status: 'available',
      children: [],
    })
  })

  test('a missing total shows its measured children as partial, never zero', () => {
    const tree = buildFolderTree(
      A,
      new Map([
        [`${A}/workspace/worktrees/one`, 40],
        [`${A}/workspace/worktrees/two`, 20],
      ])
    )
    expect(tree).toMatchObject({ bytes: 60, status: 'partial' })
    expect(buildFolderTree(A, new Map())).toMatchObject({ bytes: null, status: 'unavailable' })
  })

  test('partial paths mark the folder and its ancestors partial; unmeasured folders stay visible', () => {
    const tree = buildFolderTree(
      A,
      new Map([
        [`${A}/cache`, 10],
        [`${A}/data`, 5],
        [A, 15],
      ]),
      new Set([`${A}/data/stuck`])
    )
    expect(tree.status).toBe('partial')
    const data = tree.children.find((child) => child.name === 'data')!
    expect(data.status).toBe('partial')
    expect(data.children).toEqual([
      { name: 'stuck', path: `${A}/data/stuck`, bytes: null, status: 'unavailable', children: [] },
    ])
    expect(tree.children.find((child) => child.name === 'cache')!.status).toBe('available')
  })
})

describe('storage attribution', () => {
  test('groups homes by squad, sums growth, and keeps unmeasured homes visible', () => {
    const owner = { home: A, squadId: 'a', squadName: 'Product', label: 'Squad workspace' }
    const homes = new Map<string, HomeView>([
      [
        A,
        {
          ...view(A, [[A, 200]]),
          measuredAt: '2026-01-02T00:00:00.000Z',
          freshness: 'current',
          growth: { bytes: 50, since: '2026-01-01T00:00:00.000Z' },
        },
      ],
      [B, { ...view(B, [[B, 50]]), freshness: 'previous', growth: { bytes: -10, since: '2025-12-31T00:00:00.000Z' } }],
      [C, view(C, [[C, 500]])],
    ])
    const result = attributeStorage(homes, [
      owner,
      owner,
      { ...owner, home: B, label: 'Agent' },
      { ...owner, home: C, squadId: 'c', squadName: 'Research' },
      { ...owner, home: '/home/box_dddddddddddd', label: 'Never measured' },
    ])
    expect(result.map(({ name, bytes, status }) => ({ name, bytes, status }))).toEqual([
      { name: 'Research', bytes: 500, status: 'available' },
      { name: 'Product', bytes: 250, status: 'partial' },
    ])
    expect(result[1]!.growth).toEqual({ bytes: 40, since: '2025-12-31T00:00:00.000Z' })
    expect(result[1]!.folders.map((folder) => [folder.name, folder.bytes, folder.status, folder.freshness])).toEqual([
      ['Squad workspace', 200, 'available', 'current'],
      ['Agent', 50, 'available', 'previous'],
      ['Never measured', null, 'unavailable', undefined],
    ])
    expect(result[1]!.folders[0]!.measuredAt).toBe('2026-01-02T00:00:00.000Z')
    expect(result[0]!.growth).toBeUndefined()
    const absent = attributeStorage(new Map(), [owner])
    expect(absent[0]).toMatchObject({ bytes: null, status: 'unavailable' })
  })

  test('agent box homes carry the agent label and metadata without mutating the stored tree', () => {
    const agent = {
      id: 'agent-1',
      label: 'Fix login · Ada',
      agentTypeId: 'consultant',
      status: 'idle' as const,
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      dormantAt: null,
      createdAt: '2025-12-01T00:00:00.000Z',
    }
    const homes = new Map([
      [A, view(A, [[A, 70]])],
      [B, view(B, [[B, 30]])],
    ])
    const result = attributeStorage(homes, [
      { home: A, squadId: 's', squadName: 'Product', label: 'Squad workspace', kind: 'squad-workspace' },
      { home: B, squadId: 's', squadName: 'Product', label: agent.label, kind: 'agent', agent },
    ])
    expect(result[0]!.folders.map(({ name, kind, agent }) => ({ name, kind, agent }))).toEqual([
      { name: 'Squad workspace', kind: 'squad-workspace', agent: undefined },
      { name: 'Fix login · Ada', kind: 'agent', agent },
    ])
    expect(homes.get(B)!.folder.name).toBe('box_bbbbbbbbbbbb')
  })
})
