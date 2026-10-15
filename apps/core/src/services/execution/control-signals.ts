import { beginTransitionalOperation, endTransitionalOperation, getSession, removeSession } from './session-state'
import { disposePrecompactionController } from '../agent/precompaction/registry'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { findSessionFile, getSessionDir } from '../../lib/infra/session-files'
import { AgentSession } from '../../entities/AgentSession'
import { Agent } from '../../entities/Agent'
import { writeFileSync } from 'fs'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('control')

// Timeout for transitional state completion (ms)
const TRANSITION_TIMEOUT_MS = 10000

/**
 * Handle control signals from the API (stop/abort-tool/clear-queue/compact/reset).
 * Called by the worker when it receives a message on the agent_control channel.
 *
 * For stop: sets transitional status and aborts the session.
 * The runner's onComplete (via agent_end) handles finalization.
 */
export async function handleControlSignal(payload: {
  action: string
  agentId: string
  message?: string
  executionId?: string
}): Promise<void> {
  const active = getSession(payload.agentId)

  switch (payload.action) {
    case 'abort-tool': {
      // Only abort the current bash command, not the entire session
      if (active) {
        log.info(`abort-tool: agentId=${payload.agentId} isBashRunning=${active.session.pi.isBashRunning}`)
        active.session.pi.abortBash()
      } else {
        log.info(`abort-tool: agentId=${payload.agentId} no active session found`)
      }
      return
    }

    case 'clear-queue': {
      // agent_control notifications are broadcast to every worker. Only the
      // worker that owns the in-memory session can clear Pi's SDK queue.
      //
      // EVERY path below acks, including the failure path. The API blocks on
      // this ack (services/agent/lifecycle.ts's clearQueue); a throw that
      // escaped this case used to strand it for the full 10s timeout, after
      // which it deleted the DB rows itself and returned `success: true` —
      // while the SDK queue it could not reach still held the messages, so the
      // agent processed them anyway. The user saw a slow request, a success,
      // and their "cleared" messages being answered.
      const owned = Boolean(active)
      let cleared = 0
      let deleted = 0
      try {
        if (active) {
          // Owning worker: clear SDK queue FIRST, then delete DB rows, then ack.
          // This ordering prevents messages from becoming invisible in the DB
          // while still queued in the SDK.
          const result = active.session.pi.clearQueue()
          cleared = result.steering.length + result.followUp.length
        }
        const agent = await Agent.find(payload.agentId)
        deleted = (await agent?.deletePendingMessages()) ?? 0
        log.info(
          `clear-queue: agentId=${payload.agentId} owned=${owned} cleared ${cleared} from SDK queue, deleted ${deleted} from DB`
        )
        eventEmitter.emit('agent.queue-cleared', { agentId: payload.agentId, cleared, deleted, owned, ok: true })
      } catch (error) {
        // Ack the failure rather than staying silent: a reported failure is
        // recoverable (the user retries), a silent one is not (the API waits,
        // then lies).
        log.error(`clear-queue: agentId=${payload.agentId} owned=${owned} failed`, error)
        eventEmitter.emit('agent.queue-cleared', {
          agentId: payload.agentId,
          cleared,
          deleted,
          owned,
          ok: false,
          code: 'worker_error',
        })
      }
      return
    }

    case 'stop': {
      // A delayed stop from before resume must never abort the replacement turn.
      if (active && payload.executionId && active.executionId !== payload.executionId) return
      if (!active) {
        // No active session — the execution might be orphaned (worker crashed)
        // or in a race condition where the session hasn't started yet.
        // Directly complete the transition since there's nothing to abort.
        log.warn(`stop: No active session for agent ${payload.agentId}, completing transition directly`)
        const agent = await Agent.find(payload.agentId)
        const execution = await agent?.getActiveExecution()
        if (execution?.status === 'stopping' && (!payload.executionId || execution.id === payload.executionId)) {
          await execution.stop()
          log.info(`stop: Completed stopping → stopped for agent ${payload.agentId}`)
        }
        return
      }

      // Active session found — abort it and set up a fallback timeout. The runner's settled-run handler
      // should complete the transition, but if it doesn't (e.g., SDK bug, race
      // condition), the timeout ensures we don't stay stuck in the transitional state.
      log.info(`stop: Aborting session for agent ${payload.agentId}`)
      if (active.session.pi.isBashRunning) {
        active.session.pi.abortBash()
      }
      await active.session.pi.abort()

      // Set up fallback timeout to ensure transition completes
      setTimeout(async () => {
        try {
          const agent = await Agent.find(payload.agentId)
          if (!agent) return

          const execution = await agent.getActiveExecution()
          if (!execution || execution.id !== active.executionId) return

          if (execution.status === 'stopping') {
            if (getSession(payload.agentId)?.executionId === active.executionId) {
              log.warn(
                `stop: Force-removing still-active session after transition timeout for agent ${payload.agentId}`
              )
              removeSession(payload.agentId)
            } else {
              log.warn(`stop: Fallback completing stuck transition for agent ${payload.agentId}`)
            }

            await execution.stop()
          }
        } catch (err) {
          log.error(`stop: Fallback transition failed for agent ${payload.agentId}:`, err)
        }
      }, TRANSITION_TIMEOUT_MS)

      return
    }

    case 'compact': {
      // Manual compaction for idle agents - creates temporary session
      // API already set status to 'compacting', we just need to do the work
      log.info(`compact: agentId=${payload.agentId}`)

      // Get agent first - if not found, nothing to do
      const agent = await Agent.find(payload.agentId)
      if (!agent) {
        log.error(`compact: Agent ${payload.agentId} not found`)
        return
      }

      beginTransitionalOperation(payload.agentId, 'compact')

      let compactionResult: 'success' | 'no-session' | 'error' = 'error'
      let errorMessage: string | undefined

      try {
        // Check if session file exists
        const sessionDir = getSessionDir(payload.agentId)
        const sessionFile = findSessionFile(sessionDir)
        if (!sessionFile) {
          log.info(`compact: No session history to compact for agent ${payload.agentId}`)
          compactionResult = 'no-session'
          return
        }

        const agentType = await agent.getAgentType()
        if (!agentType) {
          log.error(`compact: Agent type ${agent.agentTypeId} not found`)
          errorMessage = 'Agent type not found'
          return
        }

        // Create temporary session for compaction
        const session = await AgentSession.create({
          model: await agent.getEffectiveModelSpec(),
          // Use non-empty string just to avoid Pi adding its own system
          // prompt—doesn't really matter as it won't be used for compaction.
          systemPrompt: ' ',
          storage: { agentId: payload.agentId },
          // This throwaway session exists only to run one compaction; wiring the
          // background pre-compaction controller would spuriously start (and
          // immediately abort) a bake when the over-threshold session loads.
          precompaction: false,
          usage: {
            feature: 'compaction',
            attribution: () => ({ agentId: payload.agentId, squadId: agent.squadId }),
          },
        })

        // Run compaction
        await session.pi.compact(payload.message)
        // Persist a fresh usage snapshot from the now-compacted session so the UI
        // reflects the reduced context immediately. Manual compaction has no
        // settling turn to write usage the way the runner path does, so without
        // this the agent keeps displaying its stale pre-compaction usage.
        await agent.update({ sessionUsage: session.captureUsage() })
        log.info(`compact: Compaction completed for agent ${payload.agentId}`)
        compactionResult = 'success'
      } catch (error) {
        log.error(`compact: Failed for agent ${payload.agentId}:`, error)
        errorMessage = error instanceof Error ? error.message : String(error)
      } finally {
        // Add system message indicating compaction result
        let systemMessage: string
        switch (compactionResult) {
          case 'success':
            systemMessage = '[System] Context compacted successfully.'
            break
          case 'no-session':
            systemMessage = '[System] No session history to compact.'
            break
          case 'error':
            systemMessage = `[System] Compaction failed${errorMessage ? `: ${errorMessage}` : ''}`
            break
        }
        await agent.recordMessage({
          role: 'assistant',
          content: systemMessage,
          metadata: { isSystem: true },
        })

        endTransitionalOperation(payload.agentId)

        // Reset status to idle
        await agent.finishCompaction()
      }
      return
    }

    case 'reset': {
      // Reset session history for idle agents - calls newSession() with no options
      log.info(`reset: agentId=${payload.agentId}`)

      const agent = await Agent.find(payload.agentId)
      if (!agent) {
        log.error(`reset: Agent ${payload.agentId} not found`)
        return
      }

      beginTransitionalOperation(payload.agentId, 'reset')

      try {
        const agentType = await agent.getAgentType()
        if (!agentType) {
          log.error(`reset: Agent type ${agent.agentTypeId} not found`)
          await agent.recordMessage({
            role: 'assistant',
            content: '[System] Session reset failed: Agent type not found',
            metadata: { isSystem: true },
          })
          return
        }

        // Create temporary session to call newSession()
        const { pi: session } = await AgentSession.create({
          model: await agent.getEffectiveModelSpec(),
          systemPrompt: ' ',
          storage: { agentId: payload.agentId },
          // Throwaway session: never wire the background controller (it would
          // rebind the live registry controller's deps to this emptied branch).
          precompaction: false,
        })

        // Reset the session to generate a new session file format.
        const sessionFile = session.sessionManager.newSession()
        if (!sessionFile) {
          throw new Error('newSession() returned false')
        }

        // Write an empty file to the session file to create it so it gets
        // chosen by the next execution.
        const header = session.sessionManager.getHeader()
        if (!header) {
          throw new Error('header is undefined')
        }
        writeFileSync(sessionFile, JSON.stringify(header) + '\n')

        log.info(`reset: Session reset completed for agent ${payload.agentId}`)

        // Reset context usage to zero (keep stats for historical tracking)
        if (agent.sessionUsage?.context) {
          await agent.update({
            sessionUsage: {
              ...agent.sessionUsage,
              context: {
                ...agent.sessionUsage.context,
                tokens: 0,
                percent: 0,
              },
            },
          })
        }

        // Add system message indicating reset
        await agent.recordMessage({
          role: 'assistant',
          content: '[System] Session history reset.',
          metadata: { isSystem: true },
        })
      } catch (error) {
        log.error(`reset: Failed for agent ${payload.agentId}:`, error)
        await agent.recordMessage({
          role: 'assistant',
          content: `[System] Session reset failed: ${error instanceof Error ? error.message : String(error)}`,
          metadata: { isSystem: true },
        })
      } finally {
        disposePrecompactionController(payload.agentId)
        endTransitionalOperation(payload.agentId)
        await agent.finishReset()
      }
      return
    }

    default:
      if (active) await active.session.pi.abort()
  }
}
