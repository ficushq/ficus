import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Agent } from '../entities/Agent'
import { Monitor } from '../entities/Monitor'
import { monitorDir, monitorWorkRoot, shellQuote } from '../services/monitors/launcher'
import {
  describeMonitorRestart,
  monitorSupervisor,
  type MonitorSupervisor,
} from '../services/monitors/monitor-supervisor'
import { getSandboxManager, type ISandboxManager } from '../services/sandbox'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
const DEFAULT_RESTART_LIMIT = 5
const MAX_RESTART_LIMIT = 20

// NOTE: This schema is intentionally a single flat object rather than a
// Type.Union (anyOf). Some LLM tool-call generators emit an empty object {}
// when faced with multiple anyOf object variants, producing unhelpful
// validation errors. Flattening to one object with a required `action` enum
// at the top level gives the model a single clear schema to satisfy, so it
// always includes `action` and the action-specific fields.
const MonitorParams = Type.Object({
  action: Type.Union([Type.Literal('create'), Type.Literal('list'), Type.Literal('get'), Type.Literal('cancel')]),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  command: Type.Optional(Type.String({ minLength: 1 })),
  cwd: Type.Optional(Type.String()),
  monitorId: Type.Optional(Type.String({ format: 'uuid' })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS })),
  maxBatchLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  maxBatchBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768 })),
  batchDebounceMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 10000 })),
  restart: Type.Optional(
    Type.Union([Type.Literal('never'), Type.Literal('on-loss')], {
      description:
        'What happens if the sandbox restarts or the process is lost without an exit code. "never" (default): the monitor fails with a clear reason. "on-loss": relaunch the same command once the sandbox is back, keeping the original timeout deadline. Use "on-loss" ONLY for idempotent, safe-to-rerun watchers (tail -F | grep, watch/poll loops); never for one-shot or side-effecting commands (builds, deploys, migrations, writes). Normal exits, cancel, timeout and overload never restart.',
    })
  ),
  restartLimit: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_RESTART_LIMIT,
      description:
        'restart="on-loss" only: consecutive rapid restarts (losses within 5 minutes of a launch) allowed before the monitor fails. Default 5; the count resets once a launch stays up 5 minutes.',
    })
  ),
})

type MonitorParamsType = {
  action: 'create' | 'list' | 'get' | 'cancel'
  label?: string
  description?: string
  command?: string
  cwd?: string
  monitorId?: string
  timeoutMs?: number
  maxBatchLines?: number
  maxBatchBytes?: number
  batchDebounceMs?: number
  restart?: 'never' | 'on-loss'
  restartLimit?: number
}

export interface MonitorToolContext {
  agentId: string
  sandboxId: string
  workspacePath: string
  supervisor?: MonitorSupervisor
  sandboxManager?: ISandboxManager
}

function result(text: string, details?: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details }
}

export function createMonitorTool(ctx: MonitorToolContext): ToolDefinition {
  return {
    name: 'monitor',
    label: 'Monitor',
    description:
      'Observe an event-driven background command in your sandbox and receive batched stdout events. Monitors should be event-driven and quiet: prefer commands that emit only actionable events (completion, error, readiness, state transition, failure), e.g. tail -F file.log | grep --line-buffered ERROR. Avoid firehose output and polling loops that print every interval; if polling is needed, loop silently and print only when the job reaches a terminal or actionable state, or filter with grep/awk. Do not use a monitor to detach a one-shot build, generation, migration, or test that must complete; run it as one foreground Bash invocation with timeout up to 3600 seconds. Default timeout 30 min; default batch caps 20 lines / 4 KiB / 750 ms. Monitors survive Core restarts; if the sandbox restarts, the command is not rerun unless you set restart="on-loss" (only for safe-to-rerun watchers). Cancel with action="cancel".',
    parameters: MonitorParams,
    async execute(_toolCallId: string, params: MonitorParamsType): Promise<AgentToolResult<unknown>> {
      const supervisor = ctx.supervisor ?? monitorSupervisor
      const sandboxManager = ctx.sandboxManager ?? getSandboxManager()
      switch (params.action) {
        case 'create': {
          if (!params.label) throw new Error('label is required for action=create')
          if (!params.command) throw new Error('command is required for action=create')
          if (params.timeoutMs && params.timeoutMs > MAX_TIMEOUT_MS)
            throw new Error('timeoutMs must be at most 24 hours')
          const restartPolicy = params.restart ?? 'never'
          if (restartPolicy !== 'never' && restartPolicy !== 'on-loss')
            throw new Error('restart must be "never" or "on-loss"')
          if (params.restartLimit !== undefined) {
            if (restartPolicy !== 'on-loss') throw new Error('restartLimit requires restart="on-loss"')
            if (
              !Number.isInteger(params.restartLimit) ||
              params.restartLimit < 0 ||
              params.restartLimit > MAX_RESTART_LIMIT
            )
              throw new Error(`restartLimit must be an integer from 0 to ${MAX_RESTART_LIMIT}`)
          }
          const monitor = await Monitor.create({
            agentId: ctx.agentId,
            sandboxId: ctx.sandboxId,
            label: params.label,
            description: params.description,
            command: params.command,
            cwd: params.cwd,
            processId: '',
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBatchLines: params.maxBatchLines ?? 20,
            maxBatchBytes: params.maxBatchBytes ?? 4096,
            batchDebounceMs: params.batchDebounceMs ?? 750,
            restartPolicy,
            restartLimit: params.restartLimit ?? DEFAULT_RESTART_LIMIT,
            logOffset: 0,
          })
          try {
            await supervisor.start(monitor)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            return result(`Failed to start monitor: ${reason}`, { success: false, monitorId: monitor.id })
          }
          return result(`Monitor created: ${monitor.id} (${describeMonitorRestart(monitor)})`, {
            success: true,
            monitorId: monitor.id,
            restartPolicy,
          })
        }
        case 'list': {
          const list = await Monitor.listForAgent(ctx.agentId)
          return result(
            list.map((m) => `${m.id} ${m.status} ${m.label} [${describeMonitorRestart(m)}]`).join('\n') ||
              'No monitors.',
            {
              monitors: list.map((m) => ({
                id: m.id,
                label: m.label,
                status: m.status,
                createdAt: m.createdAt,
                restartPolicy: m.restartPolicy,
                restartCount: m.restartCount,
                rapidRestartCount: m.rapidRestartCount,
                lastRestartReason: m.lastRestartReason,
              })),
            }
          )
        }
        case 'get': {
          if (!params.monitorId) throw new Error('monitorId is required for action=get')
          const monitor = await Monitor.find(params.monitorId)
          if (!monitor || monitor.agentId !== ctx.agentId)
            return result(`Monitor not found: ${params.monitorId}`, { success: false })
          const squadId = (await Agent.find(monitor.agentId))?.squadId ?? undefined
          const workRoot = monitorWorkRoot({ squadId, sandboxId: monitor.sandboxId })
          const logFile = `${monitorDir(workRoot, monitor.id)}/logs/current.log`
          let recentLines: string[] = []
          if (
            (await sandboxManager.execStatus(monitor.sandboxId, ['bash', '-lc', `test -f ${shellQuote(logFile)}`])) ===
            0
          ) {
            const out = await sandboxManager.exec(monitor.sandboxId, [
              'bash',
              '-lc',
              `tail -n 50 ${shellQuote(logFile)}`,
            ])
            recentLines = out.toString().split('\n').filter(Boolean).slice(-50)
          }
          const failure = monitor.failureReason ? `\nfailure: ${monitor.failureReason}` : ''
          return result(
            `Monitor ${monitor.id} (${monitor.status}; ${describeMonitorRestart(monitor)})${failure}\n${recentLines.join('\n')}`,
            {
              monitor,
              recentLines,
            }
          )
        }
        case 'cancel': {
          if (!params.monitorId) throw new Error('monitorId is required for action=cancel')
          const monitor = await Monitor.find(params.monitorId)
          if (!monitor || monitor.agentId !== ctx.agentId)
            return result(`Monitor not found: ${params.monitorId}`, { success: false })
          await supervisor.cancel(monitor.id)
          return result(`Cancel requested for monitor ${monitor.id}`, { success: true, monitorId: monitor.id })
        }
      }
    },
  }
}
