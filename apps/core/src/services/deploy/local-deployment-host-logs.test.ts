import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostSandboxManager } from '../sandbox/host/manager'
import { clearHostWorkspaceOverrides } from '../sandbox/host/workspace-overrides'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import { LocalDeploymentLogPathOutsideWorkspaceError } from './local-deployment-log-path'
import { LocalDeploymentProcessSupervisor } from './local-deployment-process-supervisor'

const SQUAD = '99999999-2222-4333-8444-555555555555'
const SANDBOX = `squad_${SQUAD}`

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(50)
  }
}

describe('local deployment logs on the host runtime', () => {
  let home: string
  let prevHome: string | undefined
  let prevRuntime: string | undefined
  let manager: HostSandboxManager
  let supervisor: LocalDeploymentProcessSupervisor

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ficus-host-logs-'))
    prevHome = process.env.HOME_DIR
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.HOME_DIR = home
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
    manager = new HostSandboxManager({ baseEnv: () => ({ PATH: process.env.PATH!, HOME: home }) })
    supervisor = new LocalDeploymentProcessSupervisor(manager)
    await manager.ensureSandbox(SANDBOX, { workspacePath: '' })
  })

  afterEach(async () => {
    await manager.cleanup()
    clearHostWorkspaceOverrides()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(home, { recursive: true, force: true })
  })

  test('streamLogs delivers lines already in the log file', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const dir = join(resolveWorkspaceLayout({ squadId: SQUAD }).workspaceMount, '.ficus', 'local-deployments', id)
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'current.log'), 'line-one\nline-two\n')

    const lines: string[] = []
    const errors: string[] = []
    const tail = supervisor.streamLogs(
      SANDBOX,
      id,
      100,
      (l) => lines.push(l),
      (e) => errors.push(e.message)
    )
    try {
      await waitFor(() => lines.length >= 2)
    } finally {
      tail.cancel()
    }
    expect(errors).toEqual([])
    expect(lines).toEqual(['line-one', 'line-two'])
  })

  test('streamLogs delivers lines appended after the stream starts', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'
    const dir = join(resolveWorkspaceLayout({ squadId: SQUAD }).workspaceMount, '.ficus', 'local-deployments', id)
    const logFile = join(dir, 'logs', 'current.log')
    const lines: string[] = []
    const errors: string[] = []
    const tail = supervisor.streamLogs(
      SANDBOX,
      id,
      100,
      (l) => lines.push(l),
      (e) => errors.push(e.message)
    )
    try {
      await Bun.sleep(500)
      writeFileSync(logFile, 'appended\n')
      await waitFor(() => lines.length >= 1)
    } finally {
      tail.cancel()
    }
    expect(errors).toEqual([])
    expect(lines).toEqual(['appended'])
  })

  test('a managed local deployment streams its launcher banner and app output', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01'
    await supervisor.startManagedLocalDeployment({
      localDeploymentId: id,
      sandboxId: SANDBOX,
      command: 'echo hello; sleep 30',
      port: 41999,
    })

    const lines: string[] = []
    const errors: string[] = []
    const tail = supervisor.streamLogs(
      SANDBOX,
      id,
      100,
      (l) => lines.push(l),
      (e) => errors.push(e.message)
    )
    try {
      await waitFor(() => lines.some((l) => l.includes('[ficus] starting')) && lines.some((l) => l.includes('hello')))
    } finally {
      tail.cancel()
      await supervisor.stopLocalDeployment(SANDBOX, `tau-local-deployment-${id.slice(0, 8)}`)
    }
    expect(errors).toEqual([])
    expect(lines.some((l) => l.includes('[ficus] starting'))).toBe(true)
    expect(lines).toContain('hello')
  }, 20000)

  test('tailAttachedLogs reads a real workspace file on the host runtime', async () => {
    const ws = resolveWorkspaceLayout({ squadId: SQUAD }).workspaceMount
    mkdirSync(join(ws, 'my-app'), { recursive: true })
    writeFileSync(join(ws, 'my-app', 'app.log'), 'one\ntwo\n')

    const result = await supervisor.tailAttachedLogs(SANDBOX, `${ws}/my-app/app.log`, 100)

    expect(result).toEqual({ kind: 'lines', lines: ['one', 'two'] })
  })

  test('a symlink pointing outside the workspace is rejected as OUTSIDE', async () => {
    const ws = resolveWorkspaceLayout({ squadId: SQUAD }).workspaceMount
    mkdirSync(join(ws, 'my-app'), { recursive: true })
    symlinkSync('/etc/hosts', join(ws, 'my-app', 'evil.log'))

    await expect(supervisor.resolveAttachedLogPath(SANDBOX, `${ws}/my-app/evil.log`)).rejects.toBeInstanceOf(
      LocalDeploymentLogPathOutsideWorkspaceError
    )
    await expect(supervisor.tailAttachedLogs(SANDBOX, `${ws}/my-app/evil.log`, 100)).rejects.toBeInstanceOf(
      LocalDeploymentLogPathOutsideWorkspaceError
    )
  })

  test('a missing log file reports unavailable, not an error', async () => {
    const ws = resolveWorkspaceLayout({ squadId: SQUAD }).workspaceMount

    const result = await supervisor.tailAttachedLogs(SANDBOX, `${ws}/my-app/never-written.log`, 100)

    expect(result).toEqual({ kind: 'unavailable' })
  })

  test('streamAttachedLogs delivers lines already in the file and appended after the stream starts', async () => {
    const ws = resolveWorkspaceLayout({ squadId: SQUAD }).workspaceMount
    mkdirSync(join(ws, 'my-app'), { recursive: true })
    const logFile = join(ws, 'my-app', 'app.log')
    writeFileSync(logFile, 'line-one\n')
    const lines: string[] = []
    const errors: string[] = []
    const { resolved } = await supervisor.resolveAttachedLogPath(SANDBOX, logFile)
    const tail = supervisor.streamAttachedLogs(
      SANDBOX,
      resolved,
      100,
      (l) => lines.push(l),
      (e) => errors.push(e.message)
    )
    try {
      await waitFor(() => lines.length >= 1)
      appendFileSync(logFile, 'line-two\n')
      await waitFor(() => lines.length >= 2)
    } finally {
      tail.cancel()
    }
    expect(errors).toEqual([])
    expect(lines).toEqual(['line-one', 'line-two'])
  }, 20000)
})
