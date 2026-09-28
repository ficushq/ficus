import { describe, test, expect, afterEach } from 'bun:test'
import {
  getSandboxManagerForRuntime,
  isVmRuntimeValue,
  isVmRuntime,
  isRemoteSandboxRuntimeValue,
  isRemoteSandboxRuntime,
  createCodingTools,
} from '../factory'
import { VmSandboxManager } from './manager'
import { K8sSandboxManager } from '../k8s/manager'
import { DockerSandboxManager } from '../docker/manager'

// The factory reads FICUS_SANDBOX_RUNTIME; restore it after every test so the
// process-global doesn't leak into sibling suites.
const savedRuntime = process.env.FICUS_SANDBOX_RUNTIME

afterEach(() => {
  if (savedRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = savedRuntime
})

describe('sandbox factory — vm runtime selection', () => {
  test('isVmRuntimeValue recognizes exactly "vm"', () => {
    expect(isVmRuntimeValue('vm')).toBe(true)
    expect(isVmRuntimeValue('k8s')).toBe(false)
    expect(isVmRuntimeValue('docker-sysbox')).toBe(false)
    expect(isVmRuntimeValue(undefined)).toBe(false)
  })

  test('isRemoteSandboxRuntimeValue covers both k8s and vm, not docker', () => {
    expect(isRemoteSandboxRuntimeValue('vm')).toBe(true)
    expect(isRemoteSandboxRuntimeValue('k8s')).toBe(true)
    expect(isRemoteSandboxRuntimeValue('docker-sysbox')).toBe(false)
    expect(isRemoteSandboxRuntimeValue('docker-socket')).toBe(false)
    expect(isRemoteSandboxRuntimeValue(undefined)).toBe(false)
  })

  test('isVmRuntime / isRemoteSandboxRuntime read the env', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(isVmRuntime()).toBe(true)
    expect(isRemoteSandboxRuntime()).toBe(true)

    process.env.FICUS_SANDBOX_RUNTIME = 'k8s'
    expect(isVmRuntime()).toBe(false)
    expect(isRemoteSandboxRuntime()).toBe(true)

    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    expect(isVmRuntime()).toBe(false)
    expect(isRemoteSandboxRuntime()).toBe(false)
  })

  test('getSandboxManagerForRuntime("vm") returns a singleton VmSandboxManager', () => {
    const mgr = getSandboxManagerForRuntime('vm')
    expect(mgr).toBeInstanceOf(VmSandboxManager)
    // Singleton: repeated lookups return the same instance.
    expect(getSandboxManagerForRuntime('vm')).toBe(mgr)
    // Distinct from the k8s / docker managers.
    expect(getSandboxManagerForRuntime('k8s')).toBeInstanceOf(K8sSandboxManager)
    expect(getSandboxManagerForRuntime('docker-sysbox')).toBeInstanceOf(DockerSandboxManager)
  })

  test('createCodingTools(vm) returns the k8s-style client-based tool set', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const tools = createCodingTools('/ignored', 'squad_s1', undefined, 's1')
    expect(tools.map((t) => t.key)).toEqual(['read', 'write', 'edit', 'bash'])
  })
})
