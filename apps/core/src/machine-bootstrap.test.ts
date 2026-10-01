import { describe, expect, it } from 'bun:test'
import type { Machine } from './services/machines/queries'
import { parseMachineBootstrapTarget, runMachineBootstrap, type MachineBootstrapDeps } from './machine-bootstrap'

const CURRENT = 'c'.repeat(64)

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
  return { id, name: `m-${id}`, status: 'ready', bootstrapVersion: CURRENT, ...overrides } as Machine
}

function fakeDeps(machines: Machine[], failing: Set<string> = new Set()) {
  const lines: string[] = []
  const errors: string[] = []
  const bootstrapped: string[] = []
  const claimed: Array<{ id: string; from?: readonly string[] }> = []
  const failedClaims: string[] = []
  const deps: MachineBootstrapDeps = {
    listMachines: async () => machines,
    currentBootstrapVersion: () => CURRENT,
    claimMachineForBootstrap: async (id, from) => {
      claimed.push({ id, from })
      const row = machines.find((m) => m.id === id)
      if (!row || row.status === 'bootstrapping') return null
      if (from && !from.includes(row.status)) return null
      return { ...row, status: 'bootstrapping' } as Machine
    },
    failMachineBootstrapClaim: async (id) => {
      failedClaims.push(id)
    },
    bootstrapMachine: async (m) => {
      bootstrapped.push(m.id)
      if (failing.has(m.id)) throw new Error(`bootstrap.sh failed on ${m.name} (exit 1): boom\nsecond line`)
      return {}
    },
    print: (line) => lines.push(line),
    printError: (line) => errors.push(line),
  }
  return { deps, lines, errors, bootstrapped, claimed, failedClaims }
}

describe('parseMachineBootstrapTarget', () => {
  it('takes a machine id or all-stale from FICUS_MB_MACHINE', () => {
    expect(parseMachineBootstrapTarget({ FICUS_MB_MACHINE: 'all-stale' })).toBe('all-stale')
    expect(parseMachineBootstrapTarget({ FICUS_MB_MACHINE: '22222222-2222-2222-2222-222222222222' })).toBe(
      '22222222-2222-2222-2222-222222222222'
    )
  })

  it('refuses a missing or shell-unsafe value', () => {
    for (const value of [undefined, '', 'a b', "x'y", '$(id)'])
      expect(() => parseMachineBootstrapTarget({ FICUS_MB_MACHINE: value })).toThrow(/FICUS_MB_MACHINE/)
  })
})

describe('runMachineBootstrap', () => {
  it('all-stale bootstraps only the machines whose stored version differs from the current one', async () => {
    const machines = [
      machine('fresh'),
      machine('stale', { bootstrapVersion: 'old' }),
      machine('never', { bootstrapVersion: null }),
      machine('down', { status: 'unreachable', bootstrapVersion: 'old' }),
      machine('gone', { status: 'terminated', bootstrapVersion: 'old' }),
    ]
    const { deps, lines, bootstrapped } = fakeDeps(machines)
    expect(await runMachineBootstrap('all-stale', deps)).toBe(0)
    expect(bootstrapped).toEqual(['stale', 'never', 'down'])
    expect(lines).toEqual(['MACHINE_BOOTSTRAP stale ok', 'MACHINE_BOOTSTRAP never ok', 'MACHINE_BOOTSTRAP down ok'])
  })

  it('one failure exits 1, and the other machines still run', async () => {
    const machines = [machine('a', { bootstrapVersion: 'old' }), machine('b', { bootstrapVersion: 'old' })]
    const { deps, lines, bootstrapped, failedClaims } = fakeDeps(machines, new Set(['a']))
    expect(await runMachineBootstrap('all-stale', deps)).toBe(1)
    expect(bootstrapped).toEqual(['a', 'b'])
    expect(lines).toEqual([
      'MACHINE_BOOTSTRAP a failed bootstrap.sh failed on m-a (exit 1): boom',
      'MACHINE_BOOTSTRAP b ok',
    ])
    // The claim is settled exactly as the route settles one.
    expect(failedClaims).toEqual(['a'])
  })

  it('a stale machine whose bootstrap is already running is reported failed, not skipped', async () => {
    const machines = [machine('busy', { status: 'bootstrapping', bootstrapVersion: 'old' })]
    const { deps, lines, bootstrapped } = fakeDeps(machines)
    expect(await runMachineBootstrap('all-stale', deps)).toBe(1)
    expect(bootstrapped).toEqual([])
    expect(lines).toEqual(['MACHINE_BOOTSTRAP busy failed a bootstrap is already running; re-run once it settles'])
  })

  it('a single id bootstraps that machine even when its version is current', async () => {
    const { deps, lines, bootstrapped, claimed } = fakeDeps([machine('one'), machine('two')])
    expect(await runMachineBootstrap('one', deps)).toBe(0)
    expect(bootstrapped).toEqual(['one'])
    expect(claimed).toEqual([{ id: 'one', from: undefined }])
    expect(lines).toEqual(['MACHINE_BOOTSTRAP one ok'])
  })

  it('an unknown id exits 2 and bootstraps nothing', async () => {
    const { deps, lines, errors, bootstrapped } = fakeDeps([machine('one')])
    expect(await runMachineBootstrap('nope', deps)).toBe(2)
    expect(bootstrapped).toEqual([])
    expect(lines).toEqual([])
    expect(errors.join('\n')).toContain('nope')
  })

  it('all-stale with nothing stale exits 0 and says so on stderr', async () => {
    const { deps, lines, errors } = fakeDeps([machine('fresh')])
    expect(await runMachineBootstrap('all-stale', deps)).toBe(0)
    expect(lines).toEqual([])
    expect(errors.join('\n')).toContain('no stale machines')
  })
})
