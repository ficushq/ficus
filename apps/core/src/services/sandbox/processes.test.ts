import { describe, expect, test } from 'bun:test'
import type { SandboxProcesses } from '@ficus/shared'
import { SandboxHttpError, type SandboxClient } from './client/http-client'
import {
  listSandboxProcesses,
  parseContainerId,
  parseProcessId,
  parseProcessSignal,
  sandboxProcessesErrorResponse,
  signalSandboxProcess,
  stopSandboxContainer,
} from './processes'

const user = { type: 'user', userId: 'u1' } as const
const listing: SandboxProcesses = {
  pressure: { cpus: 4, load: [22.7, 31.9, 30.5], memTotalMb: 7941, memAvailableMb: 3614 },
  processes: [],
  containers: { available: true, containers: [] },
}

function clientReturning(overrides: Partial<SandboxClient>): () => Promise<SandboxClient> {
  return async () => overrides as SandboxClient
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error: unknown) => sandboxProcessesErrorResponse(error)
  )
}

describe('sandbox process management', () => {
  test("passes the box's listing through and signals with the requested signal", async () => {
    const calls: unknown[][] = []
    const getClient = clientReturning({
      listProcesses: async () => listing,
      signalProcess: async (pid, signal) => {
        calls.push(['signal', pid, signal])
        return { pid, signal, command: 'bun tsc -p apps/core' }
      },
      stopContainer: async (id) => {
        calls.push(['stop', id])
        return { id }
      },
    })
    expect(await listSandboxProcesses('squad_x', getClient)).toBe(listing)
    expect(await signalSandboxProcess('squad_x', 4242, 'KILL', user, getClient)).toMatchObject({ pid: 4242 })
    expect(await stopSandboxContainer('squad_x', 'tau-core-tsc', user, getClient)).toEqual({ id: 'tau-core-tsc' })
    expect(calls).toEqual([
      ['signal', 4242, 'KILL'],
      ['stop', 'tau-core-tsc'],
    ])
  })

  test('a sandbox with no running box answers 409', async () => {
    expect(await failure(listSandboxProcesses('squad_x', async () => null))).toEqual({
      status: 409,
      body: { error: 'The sandbox is not running' },
    })
  })

  test("the box's refusals keep their status and message", async () => {
    const getClient = clientReturning({
      signalProcess: async () => {
        throw new SandboxHttpError('Process 2347436 is not owned by this box', 403)
      },
    })
    expect(await failure(signalSandboxProcess('squad_x', 2347436, 'TERM', user, getClient))).toEqual({
      status: 403,
      body: { error: 'Process 2347436 is not owned by this box' },
    })
  })

  // An older box server answers unknown routes with a plain-text 404.
  test('a box server that predates process management asks for a restart', async () => {
    const getClient = clientReturning({
      listProcesses: async () => {
        throw new SandboxHttpError('Request failed: 404', 404)
      },
    })
    expect(await failure(listSandboxProcesses('squad_x', getClient))).toEqual({
      status: 501,
      body: { error: 'This sandbox predates process management; restart it to update' },
    })
  })

  test('parses request input strictly', () => {
    expect(parseProcessSignal(undefined)).toBe('TERM')
    expect(parseProcessSignal('kill')).toBe('KILL')
    expect(() => parseProcessSignal('HUP')).toThrow('signal must be one of')
    expect(parseProcessId('2838629')).toBe(2838629)
    for (const pid of [undefined, '', '1', '0', '-3', '12a', '1e3']) expect(() => parseProcessId(pid)).toThrow('pid')
    expect(parseContainerId('tau-test-ebb213d9-postgres-1')).toBe('tau-test-ebb213d9-postgres-1')
    for (const id of [undefined, '', '-rm', 'a b', 'x;reboot'])
      expect(() => parseContainerId(id)).toThrow('containerId')
  })
})

test('control transport timeouts return actionable 504 instead of a generic server error', async () => {
  const { SandboxTransportError } = await import('./client/http-client')
  const getClient = clientReturning({
    signalProcess: async () => {
      throw new SandboxTransportError('timeout', 'connect', new Error('private endpoint'))
    },
  })
  const result = await failure(signalSandboxProcess('synthetic', 4242, 'TERM', user, getClient))
  expect(result?.status).toBe(504)
  expect(result?.body.error).toContain('Refresh processes before retrying')
  expect(result?.body.error).not.toContain('private endpoint')
})

test('bounds attachment and both controls, cancels requests, and never signals after late attachment', async () => {
  let attach!: (client: SandboxClient) => void
  const signals: AbortSignal[] = []
  let lateSignals = 0
  const getClient = clientReturning({
    signalProcess: async (_pid, _signal, abortSignal) => {
      signals.push(abortSignal!)
      return new Promise(() => {})
    },
    stopContainer: async (_id, abortSignal) => {
      signals.push(abortSignal!)
      return new Promise(() => {})
    },
  })
  const requests = [
    signalSandboxProcess(
      'synthetic',
      4242,
      'TERM',
      user,
      () =>
        new Promise((resolve) => {
          attach = resolve
        })
    ),
    signalSandboxProcess('synthetic', 4243, 'KILL', user, getClient),
    stopSandboxContainer('synthetic', 'synthetic-container', user, getClient),
  ].map((request) => failure(request))
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    const results = await Promise.race([
      Promise.all(requests),
      new Promise<null>((resolve) => {
        watchdog = setTimeout(() => resolve(null), 46_000)
      }),
    ])
    expect(results?.map((result) => result?.status)).toEqual([504, 504, 504])
    expect(signals.length).toBe(2)
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
    attach({
      signalProcess: async () => {
        lateSignals++
        return { pid: 4242, signal: 'TERM', command: 'synthetic' }
      },
    } as unknown as SandboxClient)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lateSignals).toBe(0)
  } finally {
    clearTimeout(watchdog)
  }
}, 60_000)
