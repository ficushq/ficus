import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import type { SquadStorageView } from '@ficus/shared'
import { apiGet } from '../client'
import { output, outputError, setOutputOptions } from '../output'
import { registerSquadCommands } from './squad'
import { formatAge, formatBytes, formatSquadStorage, resolveStorageSquad } from './squad-storage'

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const view: SquadStorageView = {
  squad: { id: 'squad-1', name: 'Product' },
  supported: true,
  scanning: false,
  scannedAt: '2026-10-30T11:55:00.000Z',
  oldestMeasuredAt: '2026-10-30T09:00:00.000Z',
  error: null,
  monitoring: { intervalHours: 1, nextScanAt: '2026-10-30T12:20:00.000Z' },
  dormantRetentionDays: 7,
  bytes: 3 * 1024 ** 3,
  machines: [
    {
      id: 'm1',
      name: 'worker-1',
      scan: { state: 'idle', generation: 3, passStartedAt: '2026-10-30T11:00:00.000Z', lastCompletedAt: null },
      storage: {
        id: 'squad-1',
        name: 'Product',
        bytes: 3 * 1024 ** 3,
        status: 'available',
        totalExact: true,
        growth: { bytes: 512 * 1024 ** 2, since: '2026-10-29T12:00:00.000Z' },
        folders: [
          {
            name: 'Squad workspace',
            path: '/home/box_aaaaaaaaaaaa',
            bytes: 2 * 1024 ** 3,
            status: 'available',
            kind: 'squad-workspace',
            measuredAt: '2026-10-30T11:55:00.000Z',
            freshness: 'current',
            totalExact: false,
            children: Array.from({ length: 7 }, (_, index) => ({
              name: `dir${index}`,
              path: `/home/box_aaaaaaaaaaaa/workspace/dir${index}`,
              bytes: 1024 * (7 - index),
              status: 'available' as const,
              children: [],
            })),
          },
          {
            name: 'Reviewer · Ada',
            path: '/home/box_bbbbbbbbbbbb',
            bytes: 1024 ** 3,
            status: 'partial',
            kind: 'agent',
            measuredAt: '2026-10-30T09:00:00.000Z',
            freshness: 'previous',
            agent: {
              id: '12345678-aaaa-bbbb-cccc-1234567890ab',
              label: 'Reviewer · Ada',
              agentTypeId: 'consultant',
              status: 'dormant',
              lastMessageAt: null,
              dormantAt: null,
              createdAt: null,
            },
            children: [],
          },
        ],
      },
    },
  ],
  storedFiles: {
    bytes: 2048,
    sources: [
      { key: 'agentFiles', label: 'Agent file attachments', countsTowardQuota: true, bytes: 2048 },
      { key: 'images', label: 'Images', countsTowardQuota: false, bytes: 0 },
    ],
  },
}

describe('squad storage CLI', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
  })

  async function run(args: string[], squadEnv?: string): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerSquadCommands(program)
    const previous = process.env.FICUS_SQUAD_ID
    if (squadEnv === undefined) delete process.env.FICUS_SQUAD_ID
    else process.env.FICUS_SQUAD_ID = squadEnv
    try {
      await program.parseAsync(args, { from: 'user' })
    } finally {
      if (previous === undefined) delete process.env.FICUS_SQUAD_ID
      else process.env.FICUS_SQUAD_ID = previous
    }
  }

  it('reads an explicit squad and passes the raw view to output for --json', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(view)
    await run(['squad', 'storage', 'squad 1/x'], 'env-squad')
    expect(apiGet).toHaveBeenCalledWith('/api/squads/squad%201%2Fx/storage')
    expect((output as ReturnType<typeof mock>).mock.calls[0]![0]).toBe(view)
    expect((output as ReturnType<typeof mock>).mock.calls[0]![1]).toContain('Storage for squad Product')
  })

  it('defaults to the caller squad from FICUS_SQUAD_ID', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(view)
    await run(['squad', 'storage'], 'env-squad')
    expect(apiGet).toHaveBeenCalledWith('/api/squads/env-squad/storage')
  })

  it('reports a clear error without squad context and never calls the API', async () => {
    await run(['squad', 'storage'])
    expect(apiGet).not.toHaveBeenCalled()
    expect((outputError as ReturnType<typeof mock>).mock.calls[0]![0].message).toContain('No squad context')
    expect(() => resolveStorageSquad(undefined, '')).toThrow('No squad context')
    expect(resolveStorageSquad('explicit', 'env')).toBe('explicit')
  })

  it('surfaces a refusal from the server', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockRejectedValue(new Error('Forbidden'))
    await run(['squad', 'storage', 'other-squad'])
    expect((outputError as ReturnType<typeof mock>).mock.calls[0]![0].message).toBe('Forbidden')
  })

  it('documents the permission and read-only behavior in help', () => {
    const program = new Command()
    registerSquadCommands(program)
    const storage = program.commands
      .find((command) => command.name() === 'squad')
      ?.commands.find((command) => command.name() === 'storage')
    expect(storage?.description()).toContain('storage:read')
    expect(storage?.helpInformation()).toContain('[squad-id]')
  })

  it('formats sizes, ages, markers, subfolder limits and stored files for people', () => {
    const text = formatSquadStorage(view, NOW)
    expect(text).toContain('Storage for squad Product (squad-1)')
    expect(text).toContain('Box homes: 3.0 GB. Newest measurement 5m ago, oldest 3h ago.')
    expect(text).toContain('Scanning: idle (a pass every 1h, next pass in 20m).')
    expect(text).toContain('Machine worker-1: 3.0 GB (+512.0 MB since 24h ago)')
    expect(text).toContain('  Squad workspace: ≈2.0 GB, measured 5m ago')
    expect(text).toContain(
      '  Reviewer · Ada [consultant, dormant, 12345678]: 1.0 GB (partial), measured 3h ago, from the previous pass'
    )
    expect(text).toContain('      /home/box_aaaaaaaaaaaa/workspace/dir0: 7.0 KB')
    expect(text).toContain('      /home/box_aaaaaaaaaaaa/workspace/dir4: 3.0 KB')
    expect(text).not.toContain('workspace/dir5')
    expect(text).toContain('... 2 more (use --json for the full tree)')
    expect(text).toContain('Stored files on the Ficus host: 2.0 KB')
    expect(text).toContain('  Agent file attachments: 2.0 KB')
    expect(text).toContain('removed 7 days after')
  })

  it('explains unsupported runtimes, empty squads and scan errors', () => {
    const unsupported = formatSquadStorage({ ...view, supported: false, machines: [], bytes: null }, NOW)
    expect(unsupported).toContain('not available on this runtime')
    expect(unsupported).not.toContain('Box homes:')
    const empty = formatSquadStorage(
      { ...view, machines: [], bytes: null, scannedAt: null, oldestMeasuredAt: null, error: 'Scan step failed' },
      NOW
    )
    expect(empty).toContain('Box homes: not measured. Newest measurement never, oldest never.')
    expect(empty).toContain('No box homes measured for this squad yet.')
    expect(empty).toContain('Scan error: Scan step failed')
    const manual = formatSquadStorage(
      { ...view, scanning: true, monitoring: { intervalHours: 0, nextScanAt: null } },
      NOW
    )
    expect(manual).toContain('Scanning: in progress (manual passes only).')
  })

  it('formats bytes and ages', () => {
    expect(formatBytes(null)).toBe('not measured')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(-2048)).toBe('-2.0 KB')
    expect(formatAge(null, NOW)).toBe('never')
    expect(formatAge('2026-10-27T12:00:00.000Z', NOW)).toBe('3d ago')
  })
})
