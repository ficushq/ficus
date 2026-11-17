/**
 * Stop what agents' finished commands left running in their boxes once the
 * work those commands belonged to is over.
 *
 * Every agent bash command carries its agent, work stream and flow attempt
 * (sandbox-tools.ts), and the box remembers what each one leaves running
 * (packages/sandbox-server/src/services/leftover-processes.ts). Three moments
 * end that work, each a separate trigger so one can change without the others:
 *   - a flow attempt ends (completed, returned or superseded; never a single
 *     agent turn): its leftovers in the squad box and the attempt agent's box;
 *   - an agent goes dormant: everything it left in its squad box (its own box
 *     is stopped by dormancy anyway);
 *   - a work stream is done or canceled: every agent's leftovers for it.
 *
 * The box stops them with SIGTERM, then SIGKILL after a short grace period,
 * and never touches running commands, Core's own commands, managed apps,
 * monitors, the tmux server, or processes started with FICUS_KEEP_RUNNING=1.
 * Every stop is logged here and told to the owning agent in a non-waking
 * inbox message, and the box repeats it before that agent's next command.
 *
 * Best-effort throughout: a box that is down has nothing running, and an
 * older box server without the route is skipped. Never throws.
 */

import { createLogger } from '../../lib/infra/logger'
import type {
  LeftoverProcessSelector,
  LeftoverStopReason,
  LeftoverStopResponse,
  SandboxClient,
} from './client/http-client'

const log = createLogger('leftover-processes')

export type StoppedLeftover = LeftoverStopResponse['stopped'][number] & { sandboxId: string }

export interface LeftoverCleanupDeps {
  getClient?: (sandboxId: string) => Promise<Pick<SandboxClient, 'stopLeftoverProcesses'> | null>
  notify?: (agentId: string, subject: string, content: string, metadata: Record<string, unknown>) => Promise<void>
}

async function defaultGetClient(sandboxId: string) {
  const { defaultGetClient } = await import('./processes')
  return defaultGetClient(sandboxId)
}

async function defaultNotify(agentId: string, subject: string, content: string, metadata: Record<string, unknown>) {
  const { InboxMessage } = await import('../../entities/InboxMessage')
  // System messages do not wake the agent: it reads this with its next delivery.
  await InboxMessage.send({
    recipientType: 'agent',
    recipientId: agentId,
    senderType: 'system',
    subject,
    content,
    metadata,
  })
}

const REASON_TEXT: Record<LeftoverStopReason, string> = {
  'attempt-ended': 'the flow step they were started in ended',
  'agent-dormant': 'you went dormant',
  'stream-finished': 'their work stream is done or canceled',
}

function processCount(count: number): string {
  return `${count} process${count === 1 ? '' : 'es'}`
}

/** The plain-words notice for one agent about everything stopped for it in one cleanup. */
export function leftoverStopMessage(reason: LeftoverStopReason, groups: StoppedLeftover[]): string {
  const total = groups.reduce((sum, group) => sum + group.pids.length, 0)
  const lines = groups.map((group) => {
    const where = group.sandboxId.startsWith('squad_') ? 'the shared squad box' : 'your own box'
    const killed = group.killedPids.length
      ? ` ${group.killedPids.length} of them ignored the stop request and ${group.killedPids.length === 1 ? 'was' : 'were'} killed after the grace period.`
      : ''
    const surviving = group.survivingPids.length
      ? ` Pids ${group.survivingPids.join(', ')} could not be stopped and may still be running.`
      : ''
    return `- \`${group.command}\` in ${where}: ${processCount(group.pids.length)} (pids ${group.pids.join(', ')}).${killed}${surviving}`
  })
  return [
    `Ficus stopped ${processCount(total)} that your earlier commands left running, because ${REASON_TEXT[reason]}:`,
    ...lines,
    '',
    'They were sent SIGTERM, then SIGKILL if still running after a few seconds. Start them again only if you still ' +
      'need them. To keep a service running past the end of your work, start it with FICUS_KEEP_RUNNING=1 in its ' +
      'environment (for example `FICUS_KEEP_RUNNING=1 npm run dev &`), or use `ficus deploy` for an app.',
  ].join('\n')
}

/**
 * Ask each box to stop the leftovers matching `selector`, log every stop, and
 * tell each owning agent once what was stopped and why.
 */
export async function stopLeftoverProcesses(
  input: { sandboxIds: string[]; selector: LeftoverProcessSelector; reason: LeftoverStopReason },
  deps: LeftoverCleanupDeps = {}
): Promise<StoppedLeftover[]> {
  const getClient = deps.getClient ?? defaultGetClient
  const notify = deps.notify ?? defaultNotify
  const stopped: StoppedLeftover[] = []
  for (const sandboxId of [...new Set(input.sandboxIds)]) {
    try {
      const client = await getClient(sandboxId)
      if (!client) continue
      const result = await client.stopLeftoverProcesses(input.selector, input.reason)
      for (const group of result.stopped) {
        stopped.push({ ...group, sandboxId })
        log.info(
          `Stopped leftover processes in ${sandboxId} (${input.reason}): agent ${group.agentId}` +
            `${group.workStreamId ? ` stream ${group.workStreamId}` : ''}` +
            `${group.attemptId ? ` attempt ${group.attemptId}` : ''}` +
            ` pids ${group.pids.join(',')}` +
            `${group.killedPids.length ? ` killed ${group.killedPids.join(',')}` : ''}` +
            `${group.survivingPids.length ? ` still running ${group.survivingPids.join(',')}` : ''}` +
            ` from \`${group.command}\``
        )
      }
    } catch (error) {
      // A box server that predates this route answers a plain 404.
      if ((error as { status?: unknown }).status === 404) continue
      log.warn(`Could not stop leftover processes in ${sandboxId} (${input.reason})`, error)
    }
  }
  const byAgent = new Map<string, StoppedLeftover[]>()
  for (const group of stopped) byAgent.set(group.agentId, [...(byAgent.get(group.agentId) ?? []), group])
  for (const [agentId, groups] of byAgent) {
    try {
      await notify(agentId, 'Stopped processes left running', leftoverStopMessage(input.reason, groups), {
        source: 'leftover-processes',
        reason: input.reason,
        ...(input.selector.workStreamId ? { workStreamId: input.selector.workStreamId } : {}),
        ...(input.selector.attemptId ? { attemptId: input.selector.attemptId } : {}),
      })
    } catch (error) {
      // A terminated agent cannot receive messages; the log line above remains.
      log.warn(`Could not tell agent ${agentId} about its stopped leftover processes`, error)
    }
  }
  return stopped
}

/** The squad box (where agents share processes) and each listed agent's own box. */
export function leftoverSandboxIds(squadId: string | null | undefined, agentIds: string[] = []): string[] {
  return [...(squadId ? [`squad_${squadId}`] : []), ...agentIds.map((agentId) => `agent_${agentId}`)]
}

/**
 * Attempt-end trigger: the attempts that were active before a flow transition
 * and are not after it (completed, returned, superseded), with their agents.
 */
export function endedAgentAttempts(
  activeBefore: ReadonlyArray<{ id: number }>,
  activeAfter: ReadonlyArray<{ id: number }>,
  attemptAgents: Record<string, string | undefined>
): Array<{ attemptId: number; agentId: string }> {
  const stillActive = new Set(activeAfter.map((attempt) => attempt.id))
  return activeBefore.flatMap((attempt) => {
    const agentId = attemptAgents[String(attempt.id)]
    return !stillActive.has(attempt.id) && agentId ? [{ attemptId: attempt.id, agentId }] : []
  })
}

/** Stop what an ended flow attempt left running, in the squad box and its agent's own box. */
export function stopLeftoversForEndedAttempts(
  workStreamId: string,
  squadId: string,
  attempts: Array<{ attemptId: number; agentId: string }>,
  deps?: LeftoverCleanupDeps
): Promise<StoppedLeftover[][]> {
  return Promise.all(
    attempts.map(({ attemptId, agentId }) =>
      stopLeftoverProcesses(
        {
          sandboxIds: leftoverSandboxIds(squadId, [agentId]),
          selector: { workStreamId, attemptId },
          reason: 'attempt-ended',
        },
        deps
      )
    )
  )
}

/** Stop what a dormant agent left running in its squad box (dormancy stops its own box). */
export function stopLeftoversForDormantAgent(
  agentId: string,
  squadId: string | null | undefined,
  deps?: LeftoverCleanupDeps
): Promise<StoppedLeftover[]> {
  return stopLeftoverProcesses(
    { sandboxIds: leftoverSandboxIds(squadId), selector: { agentId }, reason: 'agent-dormant' },
    deps
  )
}

/** Stop what every agent left running for a work stream that is done or canceled. */
export function stopLeftoversForFinishedStream(
  workStreamId: string,
  squadId: string,
  deps?: LeftoverCleanupDeps
): Promise<StoppedLeftover[]> {
  return stopLeftoverProcesses(
    { sandboxIds: leftoverSandboxIds(squadId), selector: { workStreamId }, reason: 'stream-finished' },
    deps
  )
}
