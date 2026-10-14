import { expect, test } from 'bun:test'
import type { Machine } from '../machines/queries'
import { buildStorageOwners, measureMachineStorage, STORAGE_SCAN_COMMAND } from './index'
import { SshTimeoutError } from '../machines/ssh'

const machine = { id: 'machine', name: 'Worker' } as Machine
const owners = [{ home: '/home/box_a', squadId: 'squad', squadName: 'Product', label: 'Workspace' }]
const stdout = 'Used 1B-blocks\n1000 2000\n\0' + '100\t/home/box_a\0' + '120\t/home\0'

test('reports disk capacity and inclusive squad totals from one bounded machine scan', async () => {
  const result = await measureMachineStorage(machine, owners, {
    run: async (target, command, opts) => {
      expect(target).toBe(machine)
      expect(command).toBe(STORAGE_SCAN_COMMAND)
      expect(command).toContain('timeout 45s nice -n 19 ionice -c 3 du -x -B1 --max-depth=4 --null /home')
      expect(opts?.timeoutMs).toBe(55000)
      return { exitCode: 0, stdout, stderr: '' }
    },
  })
  expect(result.status).toBe('available')
  expect(result.usedBytes).toBe(1000)
  expect(result.totalBytes).toBe(2000)
  expect(result.squads[0].bytes).toBe(100)
  expect(result.unattributedBytes).toBe(900)
})

test('failed and truncated scans never present missing measurements as zero usage', async () => {
  for (const result of [
    { exitCode: 124, stdout, stderr: '' },
    { exitCode: 0, stdout: stdout.replace('120\t/home\0', ''), stderr: '' },
    { exitCode: 1, stdout: 'Used 1B-blocks\n1000 2000\n\0', stderr: 'permission denied' },
  ]) {
    const measured = await measureMachineStorage(machine, owners, { run: async () => result })
    expect(measured.status).toBe('partial')
    expect(measured.unattributedBytes).toBeNull()
  }
  const unavailable = await measureMachineStorage(machine, owners, {
    run: async () => {
      throw new Error('ssh private key path')
    },
  })
  expect(unavailable.status).toBe('unavailable')
  expect(unavailable.usedBytes).toBeNull()
  expect(JSON.stringify(unavailable)).not.toContain('private key')
})

test('timeout preserves partial workspace descendants and reports missing home coverage', async () => {
  const measured = await measureMachineStorage(machine, owners, {
    run: async () => ({
      exitCode: 124,
      stdout: 'Used 1B-blocks\n1000 2000\n\0' + '70\t/home/box_a/workspace/worktrees/one\0',
      stderr: '',
    }),
  })
  expect(measured.squads[0].bytes).toBe(70)
  expect(measured.squads[0].status).toBe('partial')
  expect(measured.squads[0].folders[0].path).toBe('/home/box_a')
  expect(measured.diagnostics).toEqual({
    exitCode: 124,
    reasons: ['scan_timeout', 'incomplete_output', 'missing_home_totals'],
    expectedHomes: 1,
    measuredHomes: 0,
    missingHomes: ['/home/box_a'],
  })
  expect(measured.unattributedBytes).toBeNull()
})

test('a successful traversal cannot silently omit a bound sandbox', async () => {
  const measured = await measureMachineStorage(machine, owners, {
    run: async () => ({
      exitCode: 0,
      stdout: 'Used 1B-blocks\n1000 2000\n\0' + '120\t/home\0',
      stderr: '',
    }),
  })
  expect(measured.status).toBe('partial')
  expect(measured.squads[0].bytes).toBeNull()
  expect(measured.squads[0].status).toBe('unavailable')
  expect(measured.diagnostics?.reasons).toEqual(['missing_home_totals'])
  expect(measured.unattributedBytes).toBeNull()
})

test('classifies permission failures without publishing raw paths or inventing a timeout', async () => {
  const measured = await measureMachineStorage(machine, owners, {
    run: async () => ({
      exitCode: 1,
      stdout,
      stderr: 'du: cannot read /home/private-secret: Permission denied',
    }),
  })
  expect(measured.diagnostics?.reasons).toEqual(['permission_denied'])
  expect(measured.squads[0].status).toBe('partial')
  expect(JSON.stringify(measured)).not.toContain('private-secret')
})

test('distinguishes transport timeout from a missing home and preserves known owners', async () => {
  const measured = await measureMachineStorage(machine, owners, {
    run: async () => {
      throw new SshTimeoutError('sensitive details')
    },
  })
  expect(measured.diagnostics?.reasons).toEqual(['ssh_timeout'])
  expect(measured.squads[0].folders[0].bytes).toBeNull()
  expect(JSON.stringify(measured)).not.toContain('sensitive details')
})

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

test('a VM scan reports each agent home with its agent metadata', async () => {
  const agent = {
    id: 'a1',
    label: 'Fix login · Ada',
    agentTypeId: 'consultant',
    status: 'idle' as const,
    lastMessageAt: null,
    dormantAt: null,
    createdAt: '2025-12-01T00:00:00.000Z',
  }
  const measured = await measureMachineStorage(
    machine,
    [
      ...owners,
      { home: '/home/box_b', squadId: 'squad', squadName: 'Product', label: agent.label, kind: 'agent', agent },
    ],
    {
      run: async () => ({
        exitCode: 0,
        stdout: 'Used 1B-blocks\n1000 2000\n\0' + '100\t/home/box_a\0' + '40\t/home/box_b\0' + '140\t/home\0',
        stderr: '',
      }),
    }
  )
  expect(measured.status).toBe('available')
  const folder = measured.squads[0].folders.find((item) => item.path === '/home/box_b')
  expect(folder).toMatchObject({ name: 'Fix login · Ada', kind: 'agent', bytes: 40, agent })
})
