import { expect, test } from 'bun:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { restartResumeNotice } from '@ficus/shared/restart-context'
import { createK8sSandboxedBashTool, type SandboxToolsManager } from '../../tools/sandbox-tools'
import { wrapToolWithRecovery } from '../recovery/runtime'
import { SandboxClient } from './client/http-client'
import { drainCommands, resetCommandDrainForTests, restartContextForCommandError } from './command-drain'
import {
  db,
  agents,
  agentTypes,
  executions,
  squads,
  workStreams,
  workStreamWaits,
  recoveryEpisodes,
  recoveryAttempts,
} from '../../db'

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  try {
    while (!text.includes('\n')) {
      const next = await reader.read()
      if (next.done) throw new Error('Executor fixture exited before readiness')
      text += new TextDecoder().decode(next.value)
    }
    return text.split('\n')[0]!
  } finally {
    reader.releaseLock()
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture readiness/cleanup timed out')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('actual bash tool and recovery wrapper preserve a drained restart without charging its budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restart-context-'))
  const typeId = `restart-${crypto.randomUUID()}`
  await db.insert(agentTypes).values({ id: typeId, name: 'Restart fixture', model: 'test:model', systemPrompt: 'test' })
  const [squad] = await db.insert(squads).values({ name: typeId, purpose: 'test' }).returning()
  const [agent] = await db.insert(agents).values({ agentTypeId: typeId, squadId: squad!.id }).returning()
  const [execution] = await db.insert(executions).values({ agentId: agent!.id, status: 'running' }).returning()
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId: squad!.id, title: typeId, status: 'active', assigneeAgentId: agent!.id })
    .returning()
  // Real executor process, HTTP, streaming client, SDK Bash, recovery wrapper,
  // cancellation and on-disk registry. No production worker/box is restarted.
  const child = Bun.spawn(
    [
      'bun',
      new URL('../../../../../packages/sandbox-server/src/test-fixtures/restart-server.ts', import.meta.url).pathname,
    ],
    {
      env: { ...process.env, NODE_ENV: 'test', WORKSPACE_PATH: dir, FICUS_RESTART_TEST_ROOT: dir },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  const stderr = new Response(child.stderr).text()
  let client: SandboxClient | undefined
  let running: Promise<unknown> | undefined
  try {
    const { port } = JSON.parse(await bounded(firstLine(child.stdout), 5000)) as { port: number }
    client = new SandboxClient(`127.0.0.1:${port}`)
    const manager: SandboxToolsManager = {
      getClientForSandbox: () => client!,
      getSandboxStatus: async () => ({ status: 'running' }),
      resolveToolApiUrl: () => `http://127.0.0.1:${port}`,
    }
    const tool = wrapToolWithRecovery(
      createK8sSandboxedBashTool(dir, 'fixture', manager, undefined, { invocationOwnerId: execution!.id }),
      () => ({ agentId: agent!.id, executionId: execution!.id })
    )
    // The same idempotent operation can resume after inspecting its partial file.
    const command =
      'if [ ! -f affected ]; then printf partial > affected; printf ready; sleep 30; fi; printf completed > affected'
    const ready = Promise.withResolvers<void>()
    running = tool
      .execute(
        'long-command',
        { command, timeout: 60 },
        undefined,
        (update) => {
          if (update.content.some((part) => part.type === 'text' && part.text.includes('ready'))) ready.resolve()
        },
        {} as ExtensionToolContext
      )
      .catch((error: unknown) => error)
    await bounded(
      Promise.race([
        ready.promise,
        running.then(() => {
          throw new Error('Command ended before producing its partial output')
        }),
      ]),
      5000
    )
    const restart = { restartId: 'restart-fixture', restartedAt: '2026-10-28T21:32:00.000Z' }
    expect(await drainCommands(0, restart)).toMatchObject({ canceled: 1 })
    const outcome = await running
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toStartWith(
      'This command was cancelled by a Ficus restart at 2026-10-28T21:32:00.000Z; nothing is wrong with your work or the box. Re-run it when your sandbox is back.'
    )
    expect(restartContextForCommandError(outcome)).toEqual(restart)
    const invocationId = createHash('sha256').update(execution!.id).update('\0').update('long-command').digest('hex')
    const key = createHash('sha256').update(invocationId).digest('hex')
    expect(JSON.parse(await readFile(join(dir, 'registry/generations', `${key}.json`), 'utf8'))).toMatchObject({
      cancelReason: 'core_restart',
      restart,
      state: 'terminated',
    })
    const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, agent!.id))
    expect(record!.state).toMatchObject({ failures: 0, cycleFailures: 0, managerCycles: 0 })
    expect(
      await db
        .select({ outcome: recoveryAttempts.outcome, restartId: recoveryAttempts.restartId })
        .from(recoveryAttempts)
        .where(eq(recoveryAttempts.recoveryId, record!.id))
    ).toEqual([{ outcome: 'restart', restartId: restart.restartId }])
    expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream!.id))).toHaveLength(0)

    // The deterministic consumer inspects partial effects and explicitly chooses
    // an idempotent overwrite. This is not proof of arbitrary model obedience.
    expect(restartResumeNotice(restart)).toStartWith('Ficus restarted at 2026-10-28T21:32:00.000Z;')
    expect(await readFile(join(dir, 'affected'), 'utf8')).toBe('partial')
    resetCommandDrainForTests()
    await tool.execute('safe-retry', { command, timeout: 60 }, undefined, undefined, {} as ExtensionToolContext)
    expect(await readFile(join(dir, 'affected'), 'utf8')).toBe('completed')
    expect(
      (await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, record!.id)))[0]!.state
    ).toMatchObject({ state: 'resolved', failures: 0, cycleFailures: 0 })
    expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream!.id))).toHaveLength(0)
  } finally {
    // Stop/confirm the fixture's complete process family before ending the test.
    await drainCommands(0)
    client?.close()
    child.kill('SIGTERM')
    await bounded(child.exited, 10000)
    await running
    const diagnostics = await stderr
    resetCommandDrainForTests()
    await db.delete(squads).where(eq(squads.id, squad!.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    await rm(dir, { recursive: true, force: true })
    expect(child.exitCode, diagnostics).toBe(0)
  }
}, 30000)
