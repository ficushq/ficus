import { describe, expect, test } from 'bun:test'
import type { SandboxProcesses } from '@ficus/shared'
import { SandboxHttpError, type SandboxClient } from './k8s/http-client'
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
