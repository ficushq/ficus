import { expect, test } from 'bun:test'
import { buildStorageOwners } from './index'

test('builds owners with agent labels and metadata for each agent box on the machine', () => {
  const created = new Date('2025-12-01T00:00:00Z')
  const owners = buildStorageOwners(
    'machine',
    [
      { machineId: 'machine', sandboxId: 'squad_s1', unixUser: 'box_aaaaaaaaaaaa' },
      { machineId: 'machine', sandboxId: 'agent_a1', unixUser: 'box_bbbbbbbbbbbb' },
      { machineId: 'machine', sandboxId: 'agent_a2', unixUser: 'box_cccccccccccc' },
      { machineId: 'other', sandboxId: 'agent_a1', unixUser: 'box_dddddddddddd' },
      { machineId: 'machine', sandboxId: 'agent_gone', unixUser: 'box_eeeeeeeeeeee' },
    ],
    [{ id: 's1', name: 'Product' }],
    [
      {
        id: 'a1',
        squadId: 's1',
        agentTypeId: 'consultant',
        status: 'dormant',
        name: 'Ada',
        purpose: 'Fix login',
        lastMessageAt: new Date('2026-01-02T00:00:00Z'),
        dormantAt: new Date('2026-02-01T00:00:00Z'),
        createdAt: created,
      },
      {
        id: 'a2',
        squadId: 's1',
        agentTypeId: 'engineer',
        status: 'idle',
        name: null,
        purpose: null,
        lastMessageAt: null,
        dormantAt: null,
        createdAt: created,
      },
    ]
  )
  expect(owners).toEqual([
    {
      home: '/home/box_aaaaaaaaaaaa',
      squadId: 's1',
      squadName: 'Product',
      label: 'Squad workspace',
      kind: 'squad-workspace',
    },
    {
      home: '/home/box_bbbbbbbbbbbb',
      squadId: 's1',
      squadName: 'Product',
      label: 'Fix login · Ada',
      kind: 'agent',
      agent: {
        id: 'a1',
        label: 'Fix login · Ada',
        agentTypeId: 'consultant',
        status: 'dormant',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
        dormantAt: '2026-02-01T00:00:00.000Z',
        createdAt: '2025-12-01T00:00:00.000Z',
      },
    },
    {
      home: '/home/box_cccccccccccc',
      squadId: 's1',
      squadName: 'Product',
      label: 'engineer',
      kind: 'agent',
      agent: {
        id: 'a2',
        label: 'engineer',
        agentTypeId: 'engineer',
        status: 'idle',
        lastMessageAt: null,
        dormantAt: null,
        createdAt: '2025-12-01T00:00:00.000Z',
      },
    },
  ])
})
