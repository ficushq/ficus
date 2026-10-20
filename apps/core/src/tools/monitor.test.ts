import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, monitors } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { createMonitorTool } from './monitor'
import type { MonitorSupervisor } from '../services/monitors'
import type { ISandboxManager, SpawnHook } from '../services/sandbox'

class FakeSupervisor {
  started: string[] = []
  canceled: string[] = []
  async start(m: any) {
    this.started.push(m.id)
    await m.markRunning()
  }
  async cancel(id: string) {
    this.canceled.push(id)
  }
}
class FakeSandbox implements ISandboxManager {
  targets: string[] = []
  async ensureSandbox() {
    return 's'
  }
  async stopSandbox() {
    return { kind: 'stopped' as const }
  }
  async removeSandbox() {}
  async cleanup() {}
  getSpawnHook(): SpawnHook | null {
    return null
  }
  async exec(sandboxId: string) {
    this.targets.push(sandboxId)
    return Buffer.from('line1\nline2\n')
  }
  async execStatus(sandboxId: string) {
    this.targets.push(sandboxId)
    return 0
  }
  spawnShell() {
    return null
  }
  hasSandbox() {
    return true
  }
  toContainerPath(_: string, p: string) {
    return p
  }
  getWorkspaceLayout(_ctx: { squadId?: string; sandboxId?: string }) {
    return { workspaceMount: '/workspace', memoryMount: '/memory', cwd: '/workspace', privateMount: '/private' }
  }
  getSandboxRuntime() {
    return 'docker-sysbox' as const
  }
}

it('monitor tool description tells agents to keep monitors quiet and event-driven', () => {
  const tool = createMonitorTool({
    agentId: 'agent-1',
    sandboxId: 'sandbox-1',
    workspacePath: '/tmp',
  })

  expect(tool.description).toContain('event-driven and quiet')
  expect(tool.description).toContain('completion, error, readiness, state transition, failure')
  expect(tool.description).toContain('polling loops that print every interval')
  expect(tool.description).toContain('loop silently and print only when the job reaches a terminal or actionable state')
  expect(tool.description).toContain('Do not use a monitor to detach a one-shot build')
  expect(tool.description).toContain('foreground Bash invocation')
  expect(tool.description).toContain('3600')
})

describe('createMonitorTool', () => {
  let agentId: string
  let otherAgentId: string
  let agentTypeId: string

  beforeEach(async () => {
    agentTypeId = `monitor-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await AgentType.create({
      id: agentTypeId,
      name: 'Tool Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    agentId = (await Agent.create({ agentTypeId })).id
    otherAgentId = (await Agent.create({ agentTypeId })).id
  })

  afterEach(async () => {
    await db.delete(monitors).where(eq(monitors.agentId, agentId))
    await db.delete(monitors).where(eq(monitors.agentId, otherAgentId))
    await db.delete(agents).where(eq(agents.agentTypeId, agentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  it('create action starts a monitor and returns its id', async () => {
    const supervisor = new FakeSupervisor()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: supervisor as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      { action: 'create', label: 'watch', command: 'echo hi' },
      undefined as never,
      undefined as never,
      undefined as never
    )
    expect((res.details as any).monitorId).toBeString()
    expect(supervisor.started).toHaveLength(1)
  })

  it.each([undefined, 'private', 'squad'] as const)('persists the selected sandbox (%s)', async (sandbox) => {
    const supervisor = new FakeSupervisor()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'agent_private',
      squadSandboxId: 'squad_shared',
      workspacePath: '/tmp',
      supervisor: supervisor as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      {
        action: 'create',
        label: 'watch',
        command: 'echo hi',
        sandbox,
        cwd: '/chosen/worktree',
      },
      undefined as never,
      undefined as never,
      undefined as never
    )
    const [row] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, (res.details as any).monitorId))
    expect(row.sandboxId).toBe(sandbox === 'squad' ? 'squad_shared' : 'agent_private')
    expect(row.cwd).toBe('/chosen/worktree')
    expect(supervisor.started).toEqual([row.id])
  })

  it.each(['squad', 'another-agents-box'])(
    'rejects unavailable or arbitrary sandbox %s before creating a row',
    async (sandbox) => {
      const supervisor = new FakeSupervisor()
      const tool = createMonitorTool({
        agentId,
        sandboxId: 'agent_private',
        workspacePath: '/tmp',
        supervisor: supervisor as unknown as MonitorSupervisor,
      })
      await expect(
        tool.execute(
          'call',
          {
            action: 'create',
            label: 'watch',
            command: 'echo hi',
            sandbox,
          },
          undefined as never,
          undefined as never,
          undefined as never
        )
      ).rejects.toThrow(sandbox === 'squad' ? 'requires squad_bash access' : 'sandbox must be')
      expect(supervisor.started).toEqual([])
      expect(await db.select().from(monitors).where(eq(monitors.agentId, agentId))).toEqual([])
    }
  )

  it('create defaults to restart "never" and tracks the log from byte 0', async () => {
    const supervisor = new FakeSupervisor()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: supervisor as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      { action: 'create', label: 'watch', command: 'echo hi' },
      undefined as never,
      undefined as never,
      undefined as never
    )
    const [row] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, (res.details as any).monitorId))
    expect(row.restartPolicy).toBe('never')
    expect(row.restartLimit).toBe(5)
    expect(row.logOffset).toBe(0)
    expect((res.content[0] as any).text).toContain('restart: never')
  })

  it('create persists restart "on-loss" with a custom rapid-restart limit', async () => {
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: new FakeSupervisor() as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      { action: 'create', label: 'tail', command: 'tail -F x | grep ERR', restart: 'on-loss', restartLimit: 2 },
      undefined as never,
      undefined as never,
      undefined as never
    )
    const [row] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, (res.details as any).monitorId))
    expect(row.restartPolicy).toBe('on-loss')
    expect(row.restartLimit).toBe(2)
    expect((res.content[0] as any).text).toContain('restart: on-loss (limit 2 rapid restarts)')

    const list = await tool.execute(
      'call',
      { action: 'list' },
      undefined as never,
      undefined as never,
      undefined as never
    )
    expect((list.content[0] as any).text).toContain('[restart: on-loss (limit 2 rapid restarts)]')
    expect((list.details as any).monitors[0]).toMatchObject({ restartPolicy: 'on-loss', restartCount: 0 })
  })

  it('rejects restartLimit without restart "on-loss"', async () => {
    const supervisor = new FakeSupervisor()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: supervisor as unknown as MonitorSupervisor,
    })
    await expect(
      tool.execute(
        'call',
        { action: 'create', label: 'watch', command: 'echo hi', restartLimit: 3 },
        undefined as never,
        undefined as never,
        undefined as never
      )
    ).rejects.toThrow('restartLimit requires restart="on-loss"')
    expect(supervisor.started).toHaveLength(0)
  })

  it('documents the restart option in the tool schema and description', () => {
    const tool = createMonitorTool({ agentId: 'agent-1', sandboxId: 'sandbox-1', workspacePath: '/tmp' })
    const properties = (tool.parameters as any).properties
    expect(properties.restart.description).toContain('ONLY for idempotent, safe-to-rerun watchers')
    expect(properties.restartLimit.description).toContain('Default 5')
    expect(tool.description).toContain('restart="on-loss"')
  })

  it('create returns a structured error when the supervisor fails to start', async () => {
    class FailingSupervisor extends FakeSupervisor {
      async start() {
        throw new Error('Agent already has 3 active monitors')
      }
    }
    const supervisor = new FailingSupervisor()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: supervisor as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      { action: 'create', label: 'watch', command: 'echo hi' },
      undefined as never,
      undefined as never,
      undefined as never
    )
    expect((res.details as any).success).toBe(false)
    expect((res.content[0] as any).text).toContain('Agent already has 3 active monitors')
  })

  it('list action returns monitors for this agent only', async () => {
    await db.insert(monitors).values([
      {
        agentId,
        sandboxId: 's',
        label: 'mine',
        command: 'x',
        processId: 'p1',
        timeoutMs: 1,
        maxBatchLines: 1,
        maxBatchBytes: 256,
        batchDebounceMs: 100,
      },
      {
        agentId: otherAgentId,
        sandboxId: 's',
        label: 'other',
        command: 'x',
        processId: 'p2',
        timeoutMs: 1,
        maxBatchLines: 1,
        maxBatchBytes: 256,
        batchDebounceMs: 100,
      },
    ])
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: new FakeSupervisor() as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      { action: 'list' },
      undefined as never,
      undefined as never,
      undefined as never
    )
    expect((res.content[0] as any).text).toContain('mine')
    expect((res.content[0] as any).text).not.toContain('other')
  })

  it('rejects cancellation of a foreign monitor', async () => {
    const [row] = await db
      .insert(monitors)
      .values({
        agentId: otherAgentId,
        sandboxId: 's',
        label: 'other',
        command: 'x',
        processId: 'p',
        timeoutMs: 1,
        maxBatchLines: 1,
        maxBatchBytes: 256,
        batchDebounceMs: 100,
      })
      .returning()
    const supervisor = new FakeSupervisor()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: supervisor as unknown as MonitorSupervisor,
    })
    const res = await tool.execute(
      'call',
      { action: 'cancel', monitorId: row.id },
      undefined as never,
      undefined as never,
      undefined as never
    )
    expect((res.details as any).success).toBe(false)
    expect(supervisor.canceled).toHaveLength(0)
  })

  it('get action includes recent log lines', async () => {
    const [row] = await db
      .insert(monitors)
      .values({
        agentId,
        sandboxId: 's',
        label: 'mine',
        command: 'x',
        processId: 'p',
        timeoutMs: 1,
        maxBatchLines: 1,
        maxBatchBytes: 256,
        batchDebounceMs: 100,
      })
      .returning()
    const sandbox = new FakeSandbox()
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: new FakeSupervisor() as unknown as MonitorSupervisor,
      sandboxManager: sandbox,
    })
    const res = await tool.execute(
      'call',
      { action: 'get', monitorId: row.id },
      undefined as never,
      undefined as never,
      undefined as never
    )
    expect((res.content[0] as any).text).toContain('line1')
    expect(sandbox.targets).toEqual(['s', 's'])
  })

  it('create throws when required fields are missing (flat-schema validation)', async () => {
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: new FakeSupervisor() as unknown as MonitorSupervisor,
    })
    // label + command required for create
    await expect(
      tool.execute('call', { action: 'create' }, undefined as never, undefined as never, undefined as never)
    ).rejects.toThrow(/label is required/)
    await expect(
      tool.execute(
        'call',
        { action: 'create', label: 'watch' },
        undefined as never,
        undefined as never,
        undefined as never
      )
    ).rejects.toThrow(/command is required/)
  })

  it('get throws when monitorId is missing (flat-schema validation)', async () => {
    const tool = createMonitorTool({
      agentId,
      sandboxId: 'sandbox-1',
      workspacePath: '/tmp',
      supervisor: new FakeSupervisor() as unknown as MonitorSupervisor,
    })
    await expect(
      tool.execute('call', { action: 'get' }, undefined as never, undefined as never, undefined as never)
    ).rejects.toThrow(/monitorId is required/)
  })
})
