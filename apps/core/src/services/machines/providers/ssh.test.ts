import { describe, expect, it } from 'bun:test'
import { MachineProviderError, getMachineProvider, registerMachineProvider } from '../provider'
import type { Machine } from '../queries'
import { createSshMachineProvider } from './ssh'

function fakeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'machine-1',
    name: 'test-machine',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.1',
    sshPort: 22,
    sshUser: 'ficus',
    sshKeyId: 'machine-ssh:machine-1',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    bootstrapVersion: null,
    lastSeenAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Machine
}

describe('machine provider registry', () => {
  it('registers and retrieves a provider by key', () => {
    const fake = {
      key: `fake-${crypto.randomUUID()}`,
      provision: async () => {
        throw new Error('n/a')
      },
      terminate: async () => {},
      status: async () => 'running' as const,
    }
    registerMachineProvider(fake)
    expect(getMachineProvider(fake.key)).toBe(fake)
  })

  it('throws MachineProviderError for an unknown key', () => {
    expect(() => getMachineProvider(`unknown-${crypto.randomUUID()}`)).toThrow(MachineProviderError)
  })
})

describe('ssh machine provider', () => {
  it('has key "ssh"', () => {
    const provider = createSshMachineProvider({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
    expect(provider.key).toBe('ssh')
  })

  it('provision() throws — byo machines are registered, not provisioned', async () => {
    const provider = createSshMachineProvider({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
    await expect(provider.provision({ name: 'x' })).rejects.toThrow(MachineProviderError)
    await expect(provider.provision({ name: 'x' })).rejects.toThrow(/byo machines are registered, not provisioned/)
  })

  it('terminate() is a no-op', async () => {
    const provider = createSshMachineProvider({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
    await expect(provider.terminate(fakeMachine())).resolves.toBeUndefined()
  })

  it('status() returns "running" when exec succeeds', async () => {
    let calledWith: [Machine, string] | undefined
    const provider = createSshMachineProvider({
      exec: async (machine, command) => {
        calledWith = [machine, command]
        return { exitCode: 0, stdout: 'ok\n', stderr: '' }
      },
    })
    const machine = fakeMachine()
    await expect(provider.status(machine)).resolves.toBe('running')
    expect(calledWith?.[0]).toBe(machine)
    expect(calledWith?.[1]).toBe('echo ok')
  })

  it('status() returns "gone" when exec exits non-zero', async () => {
    const provider = createSshMachineProvider({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'connection refused' }),
    })
    await expect(provider.status(fakeMachine())).resolves.toBe('gone')
  })

  it('status() returns "gone" when exec throws', async () => {
    const provider = createSshMachineProvider({
      exec: async () => {
        throw new Error('unreachable')
      },
    })
    await expect(provider.status(fakeMachine())).resolves.toBe('gone')
  })
})
