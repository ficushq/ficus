import { describe, expect, test } from 'bun:test'
import { attributeStorage, parseDirectoryUsage } from './accounting'

describe('storage accounting', () => {
  test('attributes inclusive totals once, groups agent files, and sorts largest first', () => {
    const entries = parseDirectoryUsage(
      '100\t/home/box_a/workspace/repos/project\0' +
        '100\t/home/box_a/workspace/repos\0' +
        '150\t/home/box_a/workspace\0' +
        '200\t/home/box_a\0' +
        '50\t/home/box_b\0' +
        '500\t/home/box_c\0' +
        '800\t/home\0'
    )
    const owner = { home: '/home/box_a', squadId: 'a', squadName: 'Product', label: 'Squad workspace and tools' }
    const result = attributeStorage(entries, [
      owner,
      owner,
      { ...owner, home: '/home/box_b', label: 'Agent files' },
      { ...owner, home: '/home/box_c', squadId: 'c', squadName: 'Research' },
      { ...owner, home: '/home/missing' },
    ])
    expect(result.map(({ name, bytes }) => ({ name, bytes }))).toEqual([
      { name: 'Research', bytes: 500 },
      { name: 'Product', bytes: 250 },
    ])
    expect(result[1].folders[0].children[0].children[0].children[0]).toEqual({
      name: 'project',
      path: '/home/box_a/workspace/repos/project',
      bytes: 100,
      status: 'available',
      children: [],
    })
  })

  test('retains descendants when timeout interrupts du before parent totals, without double counting', () => {
    const result = attributeStorage(
      parseDirectoryUsage(
        '30\t/home/box_a/workspace/worktrees/one/target\0' +
          '40\t/home/box_a/workspace/worktrees/one\0' +
          '20\t/home/box_a/workspace/worktrees/two/target\0'
      ),
      [{ home: '/home/box_a', squadId: 'a', squadName: 'Product', label: 'Workspace' }],
      true
    )
    expect(result[0].bytes).toBe(60)
    expect(result[0].status).toBe('partial')
    const home = result[0].folders[0]
    expect(home.path).toBe('/home/box_a')
    expect(home.bytes).toBe(60)
    expect(home.children[0].children[0].children.map((f) => [f.name, f.bytes])).toEqual([
      ['one', 40],
      ['two', 20],
    ])
  })

  test('keeps unvisited homes visible and distinguishes them from a measured zero', () => {
    const owner = { home: '/home/box_a', squadId: 'a', squadName: 'Product', label: 'Workspace' }
    const result = attributeStorage(parseDirectoryUsage('0\t/home/box_b\0'), [
      owner,
      { ...owner, home: '/home/box_b', label: 'Agent files' },
    ])
    expect(result[0].bytes).toBe(0)
    expect(result[0].status).toBe('partial')
    expect(result[0].folders.map((f) => [f.bytes, f.status])).toEqual([
      [0, 'available'],
      [null, 'unavailable'],
    ])
    const absent = attributeStorage(new Map(), [owner])
    expect(absent[0].bytes).toBeNull()
    expect(absent[0].status).toBe('unavailable')
  })

  test('ignores an unterminated final record instead of accepting a truncated path', () => {
    expect([...parseDirectoryUsage('5\t/home/box_a\0' + '100\t/home/box_b')]).toEqual([['/home/box_a', 5]])
  })

  test('preserves unusual directory names without accepting malformed or escaping records', () => {
    const result = parseDirectoryUsage(
      '12\t/home/project with\ttab\nand newline\0' +
        '0\t/home/empty\0-1\t/home/negative\0NaN\t/home/nan\0' +
        '99999999999999999999999\t/home/overflow\0' +
        '10\t/etc/secret\0' +
        '1\t/home/../outside\0' +
        '2\t/home/box/./relative\0'
    )
    expect([...result]).toEqual([
      ['/home/project with\ttab\nand newline', 12],
      ['/home/empty', 0],
    ])
  })

  test('unowned homes and prefix neighbours are never attributed to a squad', () => {
    const result = attributeStorage(
      parseDirectoryUsage('5\t/home/box_a\0' + '100\t/home/box_ab\0' + '1000\t/home/unowned\0'),
      [{ home: '/home/box_a', squadId: 'a', squadName: 'Product', label: 'Workspace' }]
    )
    expect(result[0].bytes).toBe(5)
    expect(result[0].folders[0].children).toEqual([])
  })
})

describe('agent attribution', () => {
  test('agent box homes carry the agent label and metadata; squad homes are the squad workspace', () => {
    const agent = {
      id: 'agent-1',
      label: 'Fix login · Ada',
      agentTypeId: 'consultant',
      status: 'idle' as const,
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      dormantAt: null,
      createdAt: '2025-12-01T00:00:00.000Z',
    }
    const result = attributeStorage(parseDirectoryUsage('70\t/home/box_a\0' + '30\t/home/box_b\0'), [
      { home: '/home/box_a', squadId: 's', squadName: 'Product', label: 'Squad workspace', kind: 'squad-workspace' },
      { home: '/home/box_b', squadId: 's', squadName: 'Product', label: agent.label, kind: 'agent', agent },
    ])
    expect(result[0].folders.map(({ name, kind, agent }) => ({ name, kind, agent }))).toEqual([
      { name: 'Squad workspace', kind: 'squad-workspace', agent: undefined },
      { name: 'Fix login · Ada', kind: 'agent', agent },
    ])
    expect(JSON.stringify(result)).not.toContain('Agent files')
  })
})
