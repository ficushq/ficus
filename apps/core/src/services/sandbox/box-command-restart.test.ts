import { expect, test } from 'bun:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { restartResumeNotice } from '@ficus/shared/restart-context'
import { createK8sSandboxedBashTool, type SandboxToolsManager } from '../../tools/sandbox-tools'
import { wrapToolWithRecovery } from '../recovery/runtime'
import { SandboxClient } from './client/http-client'
import {
  drainCommands,
  withBoxCommandDrain,
  isCommandDrainActive,
  resetCommandDrainForTests,
  restartContextForCommandError,
} from './command-drain'
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

test('box-only graceful restart preserves genuine tool recovery and leaves another executor uninterrupted', async () => {
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
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  const diagnostics: Array<Promise<string>> = []
  const clients: SandboxClient[] = []
  const spawnExecutor = async (root: string) => {
    await mkdir(root, { recursive: true })
    const socket = join(root, 'executor.sock')
    const child = Bun.spawn(
      [
        process.execPath,
        process.env.FICUS_SANDBOX_TEST_SERVER_ENTRY ??
          new URL('../../../../../packages/sandbox-server/src/server.ts', import.meta.url).pathname,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          WORKSPACE_PATH: root,
          FICUS_BOX_HOME: root,
          EXECUTOR_SOCKET: socket,
          EXECUTOR_AUTH_TOKEN: 'fixture-token',
          EXECUTOR_BIND: '',
          FICUS_BOX_PORT: '',
          EXECUTOR_DOCKER_RUNTIME: '',
          EXECUTOR_IDLE_EXIT_MS: '0',
          EXECUTOR_SERVICE_CGROUP: '',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    children.push(child)
    diagnostics.push(
      Promise.all([new Response(child.stderr).text(), new Response(child.stdout).text()]).then((logs) =>
        logs.join('\n')
      )
    )
    const connection = new SandboxClient('fixture', 'fixture-token', {
      fetch: (url, init) => fetch(url, { ...init, unix: socket } as RequestInit & { unix: string }),
    })
    const bash = connection.bash.bind(connection)
    connection.bash = (options) => bash({ ...options, sourceEnv: false, activateDevbox: false })
    clients.push(connection)
    await bounded(
      (async () => {
        for (;;) {
          if (child.exitCode !== null) throw new Error('Owned server exited before readiness')
          if (
            await connection.health().then(
              () => true,
              () => false
            )
          )
            break
          await Bun.sleep(25)
        }
      })(),
      5000
    )
    return { child, connection }
  }
  let client: SandboxClient | undefined
  let running: Promise<unknown> | undefined
  let otherRunning: Promise<unknown> | undefined
  try {
    const first = await spawnExecutor(dir)
    const otherRoot = join(dir, 'unrelated-box')
    const other = await spawnExecutor(otherRoot)
    client = first.connection
    const manager: SandboxToolsManager = {
      getClientForSandbox: () => client!,
      getSandboxStatus: async () => ({ status: 'running' }),
      resolveToolApiUrl: () => 'http://fixture',
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
    const otherReady = Promise.withResolvers<void>()
    const otherTool = createK8sSandboxedBashTool(
      otherRoot,
      'other-box',
      {
        ...manager,
        getClientForSandbox: () => other.connection,
      },
      undefined,
      { invocationOwnerId: 'unrelated-fixture' }
    )
    otherRunning = otherTool.execute(
      'other-command',
      {
        command: 'printf ready; while [ ! -f release ]; do sleep .05; done; printf completed > affected',
        timeout: 60,
      },
      undefined,
      (update) => {
        if (update.content.some((part) => part.type === 'text' && part.text.includes('ready'))) otherReady.resolve()
      }
    )
    otherRunning = otherRunning.catch((error) => error)
    await bounded(otherReady.promise, 5000)
    await withBoxCommandDrain(
      'fixture',
      async (context) => {
        expect(context).toEqual(restart)
        expect(isCommandDrainActive('fixture')).toBe(true)
        expect(isCommandDrainActive('other-box')).toBe(false)
        // Only AFTER the executor has durably acknowledged cancellation may the
        // lifecycle close this connection and replace its server process.
        client!.close()
        first.child.kill('SIGTERM')
        expect(await bounded(first.child.exited, 5000)).toBe(0)
        client = (await spawnExecutor(dir)).connection
      },
      0,
      restart
    )
    expect(isCommandDrainActive('fixture')).toBe(false)
    await writeFile(join(otherRoot, 'release'), '')
    await bounded(otherRunning, 5000)
    expect(await readFile(join(otherRoot, 'affected'), 'utf8')).toBe('completed')
    expect(other.child.exitCode).toBeNull()
    const outcome = await running
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toStartWith(
      'This command was cancelled by a Ficus restart at 2026-10-28T21:32:00.000Z; nothing is wrong with your work or the box. Re-run it when your sandbox is back.'
    )
    expect(restartContextForCommandError(outcome)).toEqual(restart)
    const invocationId = createHash('sha256').update(execution!.id).update('\0').update('long-command').digest('hex')
    const key = createHash('sha256').update(invocationId).digest('hex')
    expect(
      JSON.parse(await readFile(join(dir, '.ficus/runtime/bash-invocations/generations', `${key}.json`), 'utf8'))
    ).toMatchObject({
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
    await tool.execute('safe-retry', { command, timeout: 60 }, undefined, undefined, {} as ExtensionToolContext)
    expect(await readFile(join(dir, 'affected'), 'utf8')).toBe('completed')
    expect(
      (await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, record!.id)))[0]!.state
    ).toMatchObject({ state: 'resolved', failures: 0, cycleFailures: 0 })
    expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, stream!.id))).toHaveLength(0)
  } finally {
    // Stop/confirm the fixture's complete process family before ending the test.
    await drainCommands(0)
    for (const connection of clients) connection.close()
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM')
      await bounded(child.exited, 10000)
    }
    await Promise.all([running, otherRunning])
    const stderr = await Promise.all(diagnostics)
    resetCommandDrainForTests()
    await db.delete(squads).where(eq(squads.id, squad!.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    await rm(dir, { recursive: true, force: true })
    for (const [index, child] of children.entries()) expect(child.exitCode, stderr[index]).toBe(0)
  }
}, 30000)
