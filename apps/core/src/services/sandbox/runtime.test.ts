import { afterEach, describe, expect, test } from 'bun:test'
import {
  ignoredK8sEnvKeys,
  ignoredK8sEnvWarning,
  isDockerRuntime,
  isDockerRuntimeValue,
  isHostRuntime,
  isHostRuntimeValue,
  isK8sRuntime,
  isKnownSandboxRuntimeValue,
  isLocalK8sMode,
  isRemoteSandboxRuntime,
  isRemoteSandboxRuntimeValue,
  isVmRuntime,
  isVmRuntimeValue,
  requireSandboxRuntime,
  SANDBOX_RUNTIME_VALUES,
} from './runtime'
import { hostWorkspaceLayout, resolveWorkspaceLayout } from './workspace-layout'

describe('host runtime predicates', () => {
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('isHostRuntimeValue matches exactly "host"', () => {
    expect(isHostRuntimeValue('host')).toBe(true)
    expect(isHostRuntimeValue('HOST')).toBe(false)
    expect(isHostRuntimeValue('docker')).toBe(false)
    expect(isHostRuntimeValue(undefined)).toBe(false)
  })

  test('isHostRuntime reads FICUS_SANDBOX_RUNTIME', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    expect(isHostRuntime()).toBe(true)
    delete process.env.FICUS_SANDBOX_RUNTIME
    expect(isHostRuntime()).toBe(false)
  })

  test('host is neither vm nor remote', () => {
    expect(isVmRuntimeValue('host')).toBe(false)
    expect(isRemoteSandboxRuntimeValue('host')).toBe(false)
  })
})

describe('SANDBOX_RUNTIME_VALUES', () => {
  test('is exactly the five supported runtimes', () => {
    expect([...SANDBOX_RUNTIME_VALUES]).toEqual(['docker-sysbox', 'docker-socket', 'k8s', 'vm', 'host'])
  })

  test('isKnownSandboxRuntimeValue accepts the five and rejects everything else', () => {
    for (const value of SANDBOX_RUNTIME_VALUES) expect(isKnownSandboxRuntimeValue(value)).toBe(true)
    for (const value of ['auto', 'docker', 'sysbox', 'socket', 'bogus', '', 'HOST', undefined]) {
      expect(isKnownSandboxRuntimeValue(value)).toBe(false)
    }
  })
})

describe('isDockerRuntimeValue / isDockerRuntime', () => {
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('covers both docker values only', () => {
    expect(isDockerRuntimeValue('docker-sysbox')).toBe(true)
    expect(isDockerRuntimeValue('docker-socket')).toBe(true)
    expect(isDockerRuntimeValue('k8s')).toBe(false)
    expect(isDockerRuntimeValue('vm')).toBe(false)
    expect(isDockerRuntimeValue('host')).toBe(false)
    expect(isDockerRuntimeValue('docker')).toBe(false)
    expect(isDockerRuntimeValue('sysbox')).toBe(false)
    expect(isDockerRuntimeValue(undefined)).toBe(false)
  })

  test('isDockerRuntime reads FICUS_SANDBOX_RUNTIME', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    expect(isDockerRuntime()).toBe(true)
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(isDockerRuntime()).toBe(false)
    delete process.env.FICUS_SANDBOX_RUNTIME
    expect(isDockerRuntime()).toBe(false)
  })
})

describe('requireSandboxRuntime', () => {
  const LIST = 'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host'
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('returns each of the five supported values', () => {
    for (const value of SANDBOX_RUNTIME_VALUES) {
      expect(requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: value })).toBe(value)
    }
  })

  test('throws naming the five values when unset', () => {
    expect(() => requireSandboxRuntime({})).toThrow(
      `${LIST} (is unset). Set it in .env (see docs/wiki/sandbox-runtimes.md)`
    )
  })

  test('throws naming the five values when empty', () => {
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: '' })).toThrow(
      `${LIST} (is unset). Set it in .env (see docs/wiki/sandbox-runtimes.md)`
    )
  })

  test('throws on an unknown value, quoting what it got', () => {
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: 'bogus' })).toThrow(
      `${LIST} (got "bogus"). Set it in .env (see docs/wiki/sandbox-runtimes.md)`
    )
  })

  test('hints the replacement for the legacy "sysbox" spelling', () => {
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: 'sysbox' })).toThrow(
      `${LIST} (got "sysbox"). Use docker-sysbox.`
    )
  })

  test('hints the replacement for the legacy "socket" spelling', () => {
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: 'socket' })).toThrow(
      `${LIST} (got "socket"). Use docker-socket.`
    )
  })

  test('tells auto/docker to choose a docker runtime explicitly', () => {
    for (const legacy of ['auto', 'docker']) {
      expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: legacy })).toThrow(
        `${LIST} (got "${legacy}"). Auto-detection was removed — choose docker-sysbox or docker-socket.`
      )
    }
  })

  // A plain-object lookup answers for every Object.prototype key, so a value
  // like `toString` used to splice a function's source into the hint.
  test('an inherited Object.prototype key gets the generic hint, not a prototype member', () => {
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: inherited })).toThrow(
        `${LIST} (got "${inherited}"). Set it in .env (see docs/wiki/sandbox-runtimes.md)`
      )
    }
  })

  // .env files and shell exports pick up stray whitespace; that is a typo, not
  // a different runtime. Case is NOT normalized — the five values are exact.
  test('trims surrounding whitespace but does not lowercase', () => {
    expect(requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: ' host ' })).toBe('host')
    expect(requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: '\tdocker-socket\n' })).toBe('docker-socket')
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: 'Host' })).toThrow(`${LIST} (got "Host")`)
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: '   ' })).toThrow(`${LIST} (is unset)`)
    // A trimmed legacy spelling still earns its rename hint.
    expect(() => requireSandboxRuntime({ FICUS_SANDBOX_RUNTIME: ' sysbox ' })).toThrow(
      `${LIST} (got "sysbox"). Use docker-sysbox.`
    )
  })

  test('defaults to process.env when no env is passed', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(requireSandboxRuntime()).toBe('vm')
    process.env.FICUS_SANDBOX_RUNTIME = 'sysbox'
    expect(() => requireSandboxRuntime()).toThrow('Use docker-sysbox.')
  })
})

// The boot guard trims, so ` host ` STARTS the process — every predicate must
// agree with it, or the factory hands out the host manager while
// isHostRuntime() says otherwise (and the workspace layout follows the
// predicate, not the manager).
describe('predicates trim FICUS_SANDBOX_RUNTIME exactly like the boot guard', () => {
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('" host " boots, and is host to the predicates and the workspace layout', () => {
    process.env.FICUS_SANDBOX_RUNTIME = ' host '
    expect(requireSandboxRuntime()).toBe('host')
    expect(isHostRuntime()).toBe(true)
    expect(isDockerRuntime()).toBe(false)
    expect(isRemoteSandboxRuntime()).toBe(false)
    expect(resolveWorkspaceLayout({ squadId: 'squad-1' })).toEqual(hostWorkspaceLayout({ squadId: 'squad-1' }))
  })

  test('" docker-socket " boots, and is docker to the predicates', () => {
    process.env.FICUS_SANDBOX_RUNTIME = ' docker-socket '
    expect(requireSandboxRuntime()).toBe('docker-socket')
    expect(isDockerRuntime()).toBe(true)
    expect(isHostRuntime()).toBe(false)
  })

  test('" vm " and "\\tk8s\\n" reach their own predicates', () => {
    process.env.FICUS_SANDBOX_RUNTIME = ' vm '
    expect(isVmRuntime()).toBe(true)
    expect(isRemoteSandboxRuntime()).toBe(true)
    expect(isK8sRuntime()).toBe(false)
    process.env.FICUS_SANDBOX_RUNTIME = '\tk8s\n'
    expect(isK8sRuntime()).toBe(true)
    expect(isRemoteSandboxRuntime()).toBe(true)
    expect(isVmRuntime()).toBe(false)
  })

  test('whitespace-only is no runtime at all', () => {
    process.env.FICUS_SANDBOX_RUNTIME = '   '
    expect(isHostRuntime()).toBe(false)
    expect(isDockerRuntime()).toBe(false)
    expect(isVmRuntime()).toBe(false)
    expect(isK8sRuntime()).toBe(false)
  })
})

// FICUS_K8S_* is a strict SUBSET of the k8s runtime: a key left behind in .env
// after a checkout switches runtimes must never change behaviour. A real
// install moved a local k3d instance to FICUS_SANDBOX_RUNTIME=host, kept the
// stale FICUS_K8S_LOCAL=true line, and the updater kept planning `k3d:import`.
describe('isLocalK8sMode', () => {
  const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
  const prevLocal = process.env.FICUS_K8S_LOCAL
  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    if (prevLocal === undefined) delete process.env.FICUS_K8S_LOCAL
    else process.env.FICUS_K8S_LOCAL = prevLocal
  })

  test('is true for k8s + FICUS_K8S_LOCAL=true and false for every other runtime', () => {
    for (const runtime of SANDBOX_RUNTIME_VALUES) {
      expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: runtime, FICUS_K8S_LOCAL: 'true' })).toBe(runtime === 'k8s')
      expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: runtime })).toBe(false)
      expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: runtime, FICUS_K8S_LOCAL: 'false' })).toBe(false)
      expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: runtime, FICUS_K8S_LOCAL: '' })).toBe(false)
      expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: runtime, FICUS_K8S_LOCAL: '   ' })).toBe(false)
    }
  })

  test('trims both values exactly like the boot guard', () => {
    expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: '\tk8s\n', FICUS_K8S_LOCAL: ' true ' })).toBe(true)
    expect(isLocalK8sMode({ FICUS_SANDBOX_RUNTIME: ' host ', FICUS_K8S_LOCAL: 'true' })).toBe(false)
  })

  test('FICUS_K8S_LOCAL alone, with no runtime configured, is inert', () => {
    expect(isLocalK8sMode({ FICUS_K8S_LOCAL: 'true' })).toBe(false)
  })

  test('defaults to process.env', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'k8s'
    process.env.FICUS_K8S_LOCAL = 'true'
    expect(isLocalK8sMode()).toBe(true)
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    expect(isLocalK8sMode()).toBe(false)
  })
})

describe('ignoredK8sEnvKeys / ignoredK8sEnvWarning', () => {
  test('names every set FICUS_K8S_* key, sorted, when the runtime is not k8s', () => {
    const env = { FICUS_SANDBOX_RUNTIME: 'host', FICUS_K8S_NAMESPACE: 'tau-sandboxes-dev', FICUS_K8S_LOCAL: 'true' }
    expect(ignoredK8sEnvKeys(env)).toEqual(['FICUS_K8S_LOCAL', 'FICUS_K8S_NAMESPACE'])
    expect(ignoredK8sEnvWarning(env)).toBe(
      'FICUS_K8S_LOCAL, FICUS_K8S_NAMESPACE are set but FICUS_SANDBOX_RUNTIME=host — ignoring them (they apply only to the k8s runtime)'
    )
  })

  test('says "is"/"it" for a single key', () => {
    expect(ignoredK8sEnvWarning({ FICUS_SANDBOX_RUNTIME: 'vm', FICUS_K8S_LOCAL: 'true' })).toBe(
      'FICUS_K8S_LOCAL is set but FICUS_SANDBOX_RUNTIME=vm — ignoring it (they apply only to the k8s runtime)'
    )
  })

  test('is empty under the k8s runtime — there the keys are honoured', () => {
    const env = { FICUS_SANDBOX_RUNTIME: ' k8s ', FICUS_K8S_LOCAL: 'true', FICUS_K8S_NAMESPACE: 'tau-sandboxes-dev' }
    expect(ignoredK8sEnvKeys(env)).toEqual([])
    expect(ignoredK8sEnvWarning(env)).toBeUndefined()
  })

  test('is empty when no FICUS_K8S_* key carries a value', () => {
    const env = { FICUS_SANDBOX_RUNTIME: 'host', FICUS_K8S_LOCAL: '', FICUS_K8S_RUNTIME_CLASS: '   ' }
    expect(ignoredK8sEnvKeys(env)).toEqual([])
    expect(ignoredK8sEnvWarning(env)).toBeUndefined()
    expect(ignoredK8sEnvKeys({ FICUS_SANDBOX_RUNTIME: 'docker-socket' })).toEqual([])
    expect(ignoredK8sEnvWarning({})).toBeUndefined()
  })

  test('reports an unset runtime without printing "undefined"', () => {
    expect(ignoredK8sEnvWarning({ FICUS_K8S_LOCAL: 'true' })).toBe(
      'FICUS_K8S_LOCAL is set but FICUS_SANDBOX_RUNTIME is unset — ignoring it (they apply only to the k8s runtime)'
    )
  })
})
