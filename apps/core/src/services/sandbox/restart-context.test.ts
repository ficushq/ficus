import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BashInvocationRegistry } from '../../../../../packages/sandbox-server/src/services/bash-invocation-registry'
import {
  cancelBashInvocation,
  handleBash,
  reconcileBashRecord,
} from '../../../../../packages/sandbox-server/src/services/bash'
import { restartResumeNotice } from '@ficus/shared/restart-context'
import { createHttpBashOperations, type SandboxToolsManager } from '../../tools/sandbox-tools'
import { SandboxClient } from './client/http-client'
import { drainCommands, resetCommandDrainForTests } from './command-drain'
import { db, workStreamWaits } from '../../db'

test('restart mid-command preserves attribution, exposes partial effects and permits a safe retry without opening a wait', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restart-context-'))
  const workspace = process.env.WORKSPACE_PATH
  process.env.WORKSPACE_PATH = dir
  const registry = new BashInvocationRegistry({ runtimeDir: join(dir, 'registry'), reconcile: reconcileBashRecord })
  // Real process, streaming client, cancellation, cleanup and on-disk registry;
  // only the HTTP transport is in-process. No live worker or box restart.
  const client = new SandboxClient('fixture', undefined, {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (String(url).endsWith('/bash/cancel')) {
        return Response.json(await cancelBashInvocation(body.invocationId, body.reason, registry, body.restart))
      }
      return handleBash({ ...body, sourceEnv: false, activateDevbox: false }, registry)
    },
  })
  const manager: SandboxToolsManager = {
    getClientForSandbox: () => client,
    getSandboxStatus: async () => ({ status: 'running' }),
    resolveToolApiUrl: () => 'http://fixture',
  }
  const restart = { restartId: 'restart-fixture', restartedAt: '2026-10-28T21:32:00.000Z' }
  const waitsBefore = await db.select({ id: workStreamWaits.id }).from(workStreamWaits)
  try {
    const ready = Promise.withResolvers<void>()
    const running = createHttpBashOperations(manager, 'fixture', undefined, { invocationId: 'long-command' })
      .exec('printf partial > affected; printf ready; sleep 30; printf completed > affected', dir, {
        onData: () => ready.resolve(),
        timeout: 60,
      })
      .catch((error: Error) => error)
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready.promise,
        running.then(() => {
          throw new Error('command ended before producing its partial output')
        }),
        new Promise<never>((_, reject) => {
          readyTimer = setTimeout(() => reject(new Error('command readiness timed out')), 3000)
        }),
      ])
    } finally {
      clearTimeout(readyTimer)
    }
    await drainCommands(0, restart)
    const outcome = await running
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toStartWith(
      'This command was cancelled by a Ficus restart at 2026-10-28T21:32:00.000Z; nothing is wrong with your work or the box. Re-run it when your sandbox is back.'
    )
    expect(outcome).toMatchObject({ reason: 'core_restart', restart })
    const key = createHash('sha256').update('long-command').digest('hex')
    expect(JSON.parse(await readFile(join(dir, 'registry/generations', `${key}.json`), 'utf8'))).toMatchObject({
      cancelReason: 'core_restart',
      restart,
      state: 'terminated',
    })

    // Model-provider behavior is tested separately at the initial-prompt boundary.
    // Here the recovery consumer follows that notice: wait for recovery, inspect
    // partial state, then issue a deterministic overwrite, never blind replay.
    expect(restartResumeNotice(restart)).toStartWith('Ficus restarted at 2026-10-28T21:32:00.000Z;')
    expect(await readFile(join(dir, 'affected'), 'utf8')).toBe('partial')
    resetCommandDrainForTests() // The next worker accepts commands once its sandbox is ready.
    const retry = await createHttpBashOperations(manager, 'fixture', undefined, { invocationId: 'safe-retry' }).exec(
      'printf completed > affected',
      dir,
      { onData: () => {}, timeout: 60 }
    )
    expect(retry.exitCode).toBe(0)
    expect(await readFile(join(dir, 'affected'), 'utf8')).toBe('completed')
    expect(await db.select({ id: workStreamWaits.id }).from(workStreamWaits)).toEqual(waitsBefore)
  } finally {
    await registry.terminateAll()
    resetCommandDrainForTests()
    if (workspace === undefined) delete process.env.WORKSPACE_PATH
    else process.env.WORKSPACE_PATH = workspace
    await rm(dir, { recursive: true, force: true })
  }
})
