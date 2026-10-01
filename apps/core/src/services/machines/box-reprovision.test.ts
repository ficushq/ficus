import { describe, expect, it } from 'bun:test'
import type { Machine, MachineBox } from './queries'
import { boxUnixUser, boxUnitMode } from './box-paths'
import {
  boxIdentity,
  parseReprovisionEnv,
  runBoxReprovision,
  type ReprovisionDeps,
  type ReprovisionJournal,
  type RuntimeState,
} from './box-reprovision'

const token = 'private-executor-token'
const machine = { id: 'machine-1', status: 'ready' } as Machine
function row(id = 'agent_one', status = 'ready'): MachineBox {
  return {
    sandboxId: id,
    machineId: machine.id,
    unixUser: boxUnixUser(id),
    port: 50101,
    status,
    authToken: token,
    migrating: false,
    provisionedSpecHash: 'old',
    reconcilableSpecHash: 'generation',
  } as MachineBox
}
const running: RuntimeState = {
  server: true,
  socket: true,
  proxy: false,
  docker: false,
  manager: false,
  linger: false,
  serverEnabled: false,
  socketEnabled: true,
  dockerEnabled: false,
}
const idle = { ...running, server: false }
const stopped = { ...idle, socket: false }
function env(box: MachineBox): string {
  return `EXECUTOR_AUTH_TOKEN=${box.authToken}\nEXECUTOR_PORT=${box.port}\nEXECUTOR_BIND=127.0.0.1\nPRIVATE_SECRET=do-not-print\nCUSTOM=$(touch /bad)\n`
}
function fixture(rows = [row()]) {
  const calls: string[] = [],
    lines: string[] = []
  const installed: Parameters<ReprovisionDeps['install']>[0][] = []
  const journals = new Map<string, ReprovisionJournal>()
  let actual = { ...running }
  const deps: ReprovisionDeps = {
    assertMaintenance: async () => {
      calls.push('maintenance')
    },
    listBoxes: async () => rows.map((r) => ({ ...r })),
    getMachine: async () => machine,
    requiresMigration: async () => false,
    readEnv: async (_, b) => env(b),
    captureRuntime: async (_, b) => ({
      ...actual,
      ...(b.sandboxId.startsWith('agent_') ? {} : { manager: true, linger: true }),
    }),
    restoreRuntime: async (_, b, state) => {
      calls.push(`restore:${b.sandboxId}`)
      actual = { ...state }
    },
    ensureArtifacts: async () => {
      calls.push('artifacts')
    },
    install: async (opts) => {
      calls.push(`install:${opts.sandboxId}`)
      installed.push(opts)
      actual = { ...running }
    },
    verifyInstalled: async (_, b) => {
      calls.push(`verify-installed:${b.sandboxId}`)
    },
    checkRunning: async (_, b) => {
      calls.push(`health:${b.sandboxId}`)
    },
    invalidateStamp: async (b) => {
      calls.push(`invalidate:${b.sandboxId}`)
      rows.find((r) => r.sandboxId === b.sandboxId)!.provisionedSpecHash = null
    },
    journal: {
      read: async (id) => journals.get(id) ?? null,
      write: async (id, j) => {
        calls.push(`journal:${j.done}`)
        journals.set(id, structuredClone(j))
      },
    },
    print: (line) => {
      lines.push(line)
    },
  }
  return {
    deps,
    calls,
    lines,
    installed,
    journals,
    rows,
    get actual() {
      return actual
    },
    set actual(value) {
      actual = value
    },
  }
}
const writes = (f: ReturnType<typeof fixture>) =>
  f.calls.filter((c) => /^(journal|artifacts|install|restore|invalidate)/.test(c))

describe('maintenance box reprovision', () => {
  it('reuses fixed placement, role, env and stable token without removal or canonical stamping', async () => {
    const f = fixture([row('agent_one'), row('consultants_four'), row('squad_two'), row('system_manager_three')])
    expect(await runBoxReprovision('all', f.deps)).toBe(0)
    expect(f.installed.map((i) => i.role)).toEqual(['agent', 'agent', 'squad', 'system-manager'])
    expect(f.installed.map((i) => boxUnitMode(i.sandboxId))).toEqual(['system', 'user', 'user', 'user'])
    expect(f.installed.map((i) => i.env.FICUS_SANDBOX_ROLE)).toEqual(['agent', 'agent', 'squad', 'squad'])
    expect(f.calls.filter((c) => c === 'artifacts')).toHaveLength(1)
    for (const i of f.installed) {
      expect([i.machine.id, i.unixUser, i.port, i.authToken]).toEqual([
        'machine-1',
        boxUnixUser(i.sandboxId),
        50101,
        token,
      ])
      expect(i.env.CUSTOM).toBe('$(touch /bad)')
      expect(i.env.PRIVATE_SECRET).toBe('do-not-print')
    }
    expect(
      f.rows.every(
        (r) => r.status === 'ready' && r.provisionedSpecHash === null && r.reconcilableSpecHash === 'generation'
      )
    ).toBe(true)
    expect(f.calls.indexOf('journal:false')).toBeLessThan(f.calls.indexOf('artifacts'))
    expect(f.lines.join('\n')).not.toMatch(/private-executor-token|do-not-print/)
    expect(JSON.stringify([...f.journals])).not.toMatch(/private-executor-token|do-not-print/)
  })
  it('includes stopped boxes and preserves stopped and socket-idle intent without health wakeup', async () => {
    for (const [status, runtime] of [
      ['stopped', stopped],
      ['ready', idle],
    ] as const) {
      const f = fixture([row('agent_one', status)])
      f.actual = { ...runtime }
      expect(await runBoxReprovision('all', f.deps)).toBe(0)
      expect(f.actual).toEqual(runtime)
      expect(f.calls.some((c) => c.startsWith('health:'))).toBe(false)
      expect(f.rows[0]!.status).toBe(status)
    }
  })
  it('preflights every selected env before any mutation', async () => {
    const f = fixture([row('agent_one'), row('squad_two')])
    f.deps.readEnv = async (_, b) => (b.sandboxId === 'squad_two' ? `${env(b)}EXECUTOR_AUTH_TOKEN=ambiguous\n` : env(b))
    expect(await runBoxReprovision('all', f.deps)).toBe(1)
    expect(writes(f)).toEqual([])
    expect(f.lines[0]).toContain('ambiguous-server-env')
  })
  it('refuses active maintenance, migrating/unsettled, unknown role, missing auth and unmigrated hosts before writes', async () => {
    const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.deps.assertMaintenance = async () => {
          throw new Error('active execution')
        }
      },
      (f) => {
        f.rows[0]!.migrating = true
      },
      (f) => {
        f.rows[0]!.status = 'stop_unverified'
      },
      (f) => {
        f.rows[0]!.sandboxId = 'unknown_one'
      },
      (f) => {
        f.rows[0]!.authToken = null
      },
      (f) => {
        f.rows[0]!.unixUser = 'box_deadbeef1234'
      },
      (f) => {
        f.deps.requiresMigration = async () => true
      },
      (f) => {
        f.deps.getMachine = async () => null
      },
      (f) => {
        f.deps.readEnv = async () => ''
      },
    ]
    for (const change of cases) {
      const f = fixture()
      change(f)
      expect(await runBoxReprovision('all', f.deps)).toBe(1)
      expect(writes(f)).toEqual([])
    }
  })
  it('preserves active, idle and stopped consultant user runtimes while provisioning the agent role', async () => {
    for (const runtime of [
      { ...running, manager: true, linger: true },
      { ...idle, manager: true, linger: true },
      stopped,
    ]) {
      const status = runtime.socket ? 'ready' : 'stopped'
      const f = fixture([row('consultants_four', status)])
      f.deps.captureRuntime = async () => ({ ...runtime })
      expect(await runBoxReprovision('all', f.deps)).toBe(0)
      expect(f.installed[0]!.role).toBe('agent')
      expect(f.installed[0]!.env.FICUS_SANDBOX_ROLE).toBe('agent')
      expect(f.actual).toEqual(runtime)
      expect(f.rows[0]!.status).toBe(status)
      expect(f.calls.includes('health:consultants_four')).toBe(runtime.server)
    }
  })
  it('refuses every user-mode runtime without its original user manager, including agent-role consultants', async () => {
    for (const id of ['squad_two', 'system_manager_three', 'consultants_four']) {
      const f = fixture([row(id)])
      f.deps.captureRuntime = async () => ({ ...running, manager: false })
      expect(await runBoxReprovision('all', f.deps)).toBe(1)
      expect(writes(f)).toEqual([])
      expect(f.lines[0]).toContain('user-runtime-without-manager')
    }
  })
  it('refuses new rows or changed placement after read-only preflight', async () => {
    for (const changed of [
      [row(), row('agent_new')],
      [{ ...row(), machineId: 'other' }],
      [{ ...row(), migrating: true }],
      [{ ...row(), reconcilableSpecHash: 'other-generation' }],
    ]) {
      const f = fixture()
      let reads = 0
      f.deps.listBoxes = async () => (++reads === 1 ? [row()] : changed)
      expect(await runBoxReprovision('all', f.deps)).toBe(1)
      expect(writes(f)).toEqual([])
      expect(f.lines[0]).toContain('inventory-changed')
    }
  })
  it('restores runtime after installation error, leaves a pending journal and redacts error text', async () => {
    const f = fixture([row('agent_one', 'stopped')])
    f.actual = { ...stopped }
    f.deps.install = async () => {
      f.actual = { ...running }
      throw new Error('SECRET=do-not-print')
    }
    expect(await runBoxReprovision('all', f.deps)).toBe(1)
    expect(f.actual).toEqual(stopped)
    expect(f.journals.get('agent_one')?.done).toBe(false)
    expect(f.calls.some((c) => c.startsWith('invalidate'))).toBe(false)
    expect(f.lines[0]).toContain('install-failed-runtime-restored')
    expect(f.lines.join('\n')).not.toContain('do-not-print')
  })
  it('a crash retry uses durable original intent instead of the now-running socket', async () => {
    const f = fixture([row('agent_one', 'stopped')])
    f.journals.set('agent_one', { version: 1, identity: boxIdentity(f.rows[0]!), runtime: { ...stopped }, done: false })
    // Models SIGKILL after installation, before restoration. Live state is running.
    expect(await runBoxReprovision('all', f.deps)).toBe(0)
    expect(f.actual).toEqual(stopped)
    expect(f.calls.some((c) => c.startsWith('health:'))).toBe(false)
    expect(f.journals.get('agent_one')?.done).toBe(true)
  })
  it('refuses a pending journal for changed identity and retains intent on restore failure', async () => {
    const f = fixture()
    f.journals.set('agent_one', { version: 1, identity: 'other', runtime: running, done: false })
    expect(await runBoxReprovision('all', f.deps)).toBe(1)
    expect(writes(f)).toEqual([])
    f.journals.clear()
    f.deps.restoreRuntime = async () => {
      throw new Error('secret SSH output')
    }
    expect(await runBoxReprovision('all', f.deps)).toBe(1)
    expect(f.journals.get('agent_one')?.done).toBe(false)
    expect(f.lines.at(-1)).toContain('restore-runtime-failed')
    expect(f.lines.join('\n')).not.toContain('secret SSH output')
  })
  it('restores dormant intent and refuses success when installed browser token verification fails', async () => {
    const f = fixture([row('agent_one', 'stopped')])
    f.actual = { ...stopped }
    f.deps.verifyInstalled = async () => {
      throw new Error('browser token mismatch secret')
    }
    expect(await runBoxReprovision('all', f.deps)).toBe(1)
    expect(f.actual).toEqual(stopped)
    expect(f.journals.get('agent_one')?.done).toBe(false)
    expect(f.calls.some((c) => c.startsWith('invalidate'))).toBe(false)
    expect(f.lines.join(' ')).not.toContain('secret')
  })
  it('does not claim success if the authenticated running probe fails', async () => {
    const f = fixture()
    f.deps.checkRunning = async () => {
      throw new Error('bad auth private-executor-token')
    }
    expect(await runBoxReprovision('all', f.deps)).toBe(1)
    expect(f.journals.get('agent_one')?.done).toBe(false)
    expect(f.calls.some((c) => c.startsWith('invalidate'))).toBe(false)
    expect(f.lines.at(-1)).toContain('verify-running-failed')
  })
})

describe('server.env parser', () => {
  it('preserves literal shell syntax without evaluating it and rejects ambiguous identity', () => {
    expect(parseReprovisionEnv(env(row()), row()).CUSTOM).toBe('$(touch /bad)')
    expect(parseReprovisionEnv(env(row()) + 'lower_key=preserved\n', row()).lower_key).toBe('preserved')
    for (const bad of [
      env(row()).replace(token, 'wrong'),
      env(row()).replace('50101', '9999'),
      env(row()) + 'BAD LINE\n',
      env(row()) + 'X=a\r\n',
    ])
      expect(() => parseReprovisionEnv(bad, row())).toThrow()
  })
})
