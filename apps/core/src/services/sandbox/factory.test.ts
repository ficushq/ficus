import { afterEach, beforeEach, describe, test, expect, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCodingTools,
  getSandboxManagerForRuntime,
  isHostRuntimeValue,
  isK8sRuntimeValue,
  validateSandboxSetup,
} from './factory'
import { DockerSandboxManager } from './docker/manager'
import { HostSandboxManager } from './host/manager'
import { clearHostWorkspaceOverrides } from './host/workspace-overrides'
import { resetHostBaseEnvCache } from './host/env'

describe('Runtime Selection Factory', () => {
  test('isK8sRuntimeValue returns false by default', () => {
    expect(isK8sRuntimeValue(undefined)).toBe(false)
  })

  test('isK8sRuntimeValue returns true when FICUS_SANDBOX_RUNTIME=k8s', () => {
    expect(isK8sRuntimeValue('k8s')).toBe(true)
  })

  test('isK8sRuntimeValue returns false for other values', () => {
    expect(isK8sRuntimeValue('docker')).toBe(false)
    expect(isK8sRuntimeValue('other')).toBe(false)
  })

  test('getSandboxManagerForRuntime returns the Docker manager for docker-socket', () => {
    const manager = getSandboxManagerForRuntime('docker-socket')
    expect(manager).toBeInstanceOf(DockerSandboxManager)
    expect(getSandboxManagerForRuntime('docker-sysbox')).toBe(manager)
    expect(typeof manager.ensureSandbox).toBe('function')
    expect(typeof manager.stopSandbox).toBe('function')
    expect(typeof manager.removeSandbox).toBe('function')
    expect(typeof manager.cleanup).toBe('function')
    expect(typeof manager.exec).toBe('function')
    expect(typeof manager.execStatus).toBe('function')
    expect(typeof manager.getSpawnHook).toBe('function')
    expect(typeof manager.spawnShell).toBe('function')
    expect(typeof manager.hasSandbox).toBe('function')
    expect(typeof manager.toContainerPath).toBe('function')
    expect(typeof manager.getWorkspaceLayout).toBe('function')
    expect(typeof manager.getSandboxRuntime).toBe('function')
  })

  test('getSandboxManagerForRuntime throws for unset / legacy / unknown runtimes instead of defaulting to docker', () => {
    expect(() => getSandboxManagerForRuntime(undefined)).toThrow(
      'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host (is unset)'
    )
    expect(() => getSandboxManagerForRuntime('sysbox')).toThrow(
      'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host (got "sysbox"). Use docker-sysbox.'
    )
    expect(() => getSandboxManagerForRuntime('socket')).toThrow('Use docker-socket.')
    expect(() => getSandboxManagerForRuntime('auto')).toThrow(
      'Auto-detection was removed — choose docker-sysbox or docker-socket.'
    )
    expect(() => getSandboxManagerForRuntime('bogus')).toThrow('(got "bogus")')
  })

  test('validateSandboxSetup throws the runtime list when FICUS_SANDBOX_RUNTIME is unset, before probing docker', () => {
    const prev = process.env.FICUS_SANDBOX_RUNTIME
    delete process.env.FICUS_SANDBOX_RUNTIME
    const spawnSpy = spyOn(Bun, 'spawnSync')
    try {
      expect(() => validateSandboxSetup()).toThrow(
        'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host (is unset)'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    }
  })
})

// The tool factory used to `return createDockerSandboxedCodingTools(...)` as
// its fallthrough, so an unset or legacy FICUS_SANDBOX_RUNTIME silently handed
// the agent Docker tools — the exact silent-default the explicit-runtime work
// removed everywhere else.
describe('createCodingTools requires an explicit runtime', () => {
  const LIST = 'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host'
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('throws instead of falling through to docker when the runtime is unset', () => {
    delete process.env.FICUS_SANDBOX_RUNTIME
    expect(() => createCodingTools('/w', 'agent_a1')).toThrow(`${LIST} (is unset)`)
  })

  test('throws for legacy and unknown values, naming what it got', () => {
    for (const value of ['bogus', 'sysbox', 'socket', 'auto', 'docker']) {
      process.env.FICUS_SANDBOX_RUNTIME = value
      expect(() => createCodingTools('/w', 'agent_a1')).toThrow(`${LIST} (got "${value}")`)
    }
  })

  // Both docker runtimes still REACH the docker tool builder: it refuses here
  // only because no sandbox executor is registered in a unit test, which is
  // precisely the proof that dispatch went to docker and not to the guard.
  test('both docker runtimes still reach the docker tool builder', () => {
    for (const value of ['docker-sysbox', 'docker-socket']) {
      process.env.FICUS_SANDBOX_RUNTIME = value
      expect(() => createCodingTools('/w', 'agent_a1')).toThrow('No sandbox executor found for agent_a1')
    }
  })

  // requireSandboxRuntime trims, so the dispatchers must trim too — otherwise
  // ` host ` passes the boot guard and then hits the "unreachable" fallthrough.
  test('a whitespace-padded value dispatches like its trimmed form', () => {
    expect(getSandboxManagerForRuntime(' host ')).toBe(getSandboxManagerForRuntime('host'))
    process.env.FICUS_SANDBOX_RUNTIME = ' docker-socket '
    expect(() => createCodingTools('/w', 'agent_a1')).toThrow('No sandbox executor found for agent_a1')
  })
})

describe('host runtime factory dispatch', () => {
  test('getSandboxManagerForRuntime("host") returns the host manager singleton', () => {
    const a = getSandboxManagerForRuntime('host')
    expect(a).toBeInstanceOf(HostSandboxManager)
    expect(getSandboxManagerForRuntime('host')).toBe(a)
    expect(isHostRuntimeValue('host')).toBe(true)
  })

  test('validateSandboxSetup on host does not require a docker image and warns UNSANDBOXED', () => {
    const prev = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const spawnSpy = spyOn(Bun, 'spawnSync')
    try {
      expect(() => validateSandboxSetup()).not.toThrow()
      const expectedUser = process.env.USER ?? String(process.getuid?.() ?? 'unknown')
      const warned = warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('UNSANDBOXED') && arg.includes(expectedUser))
      )
      expect(warned).toBe(true)
      // Passing must be because of the host early-return, not because a docker
      // image happens to be present locally on this machine.
      expect(spawnSpy).not.toHaveBeenCalledWith(
        expect.arrayContaining(['docker', 'image', 'inspect']),
        expect.anything()
      )
    } finally {
      warnSpy.mockRestore()
      spawnSpy.mockRestore()
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    }
  })

  describe('createCodingTools dispatch', () => {
    const SQUAD = '11111111-2222-4333-8444-555555555555'
    let home: string
    let prevHome: string | undefined
    let prevRuntime: string | undefined
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'tau-factory-host-'))
      prevHome = process.env.HOME_DIR
      prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
      process.env.HOME_DIR = home
      process.env.FICUS_SANDBOX_RUNTIME = 'host'
      clearHostWorkspaceOverrides()
      resetHostBaseEnvCache()
      mkdirSync(join(home, 'private', 'agent_a1'), { recursive: true })
    })
    afterEach(() => {
      clearHostWorkspaceOverrides()
      resetHostBaseEnvCache()
      if (prevHome === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = prevHome
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
      rmSync(home, { recursive: true, force: true })
    })

    test('createCodingTools dispatches to the host coding tools under FICUS_SANDBOX_RUNTIME=host', () => {
      const tools = createCodingTools('', 'agent_a1', 'tok', SQUAD)
      expect(tools.map((t) => t.key)).toEqual(['read', 'write', 'edit', 'bash'])
      const bash = tools.find((t) => t.key === 'bash')!
      // Host bash tool's description is the "on this machine" variant, not the
      // container-runtime bash description — proves the host branch fired
      // rather than falling through to the docker default.
      expect(bash.description).toContain('on this machine')
    })
  })
})
