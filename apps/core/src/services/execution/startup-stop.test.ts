import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, executionAdmissionReservations } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import * as runners from '../../entities/agent-runners'
import type { AgentSession } from '../../entities/AgentSession'
import {
  AdmissionReservationStore,
  AdmissionScope,
  attachAdmissionLeaseToError,
} from '../maintenance/admission-reservation'
import { markExecutionStartupFailure } from './startup-retry'
import {
  getSession,
  registerSession,
  removeSession,
  removeSessionForExecution,
  releaseSessionReservation,
  reserveSession,
  isSessionReserved,
} from './session-state'
import { handleControlSignal } from './control-signals'
import { StreamBuffer, streamManager } from '../streaming/buffer'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('stopping an execution during startup', () => {
  let agent: Agent
  let typeId: string
  let runnerSpy: ReturnType<typeof spyOn> | undefined
  const buffers: string[] = []
  beforeEach(async () => {
    typeId = `startup-stop-${crypto.randomUUID()}`
    await AgentType.create({ id: typeId, name: 'Startup stop', model: 'test', systemPrompt: 'test' })
    agent = await Agent.create({ agentTypeId: typeId })
  })
  afterEach(async () => {
    runnerSpy?.mockRestore()
    runnerSpy = undefined
    removeSession(agent.id)
    for (const id of buffers.splice(0)) streamManager.removeById(id)
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  async function running() {
    const execution = await agent.queueExecution({ message: 'Preserve this request' })
    expect(await execution.start()).toBe(true)
    const store = new AdmissionReservationStore('startup-stop-test', crypto.randomUUID())
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    await db
      .update(executions)
      .set({ runnerClaimToken: lease.token, runnerClaimGeneration: lease.generation })
      .where(eq(executions.id, execution.id))
    await execution.reload()
    buffers.push(execution.id)
    const buffer = streamManager.create(execution.id)
    return { execution, store, lease, buffer }
  }

  for (const phase of ['sandbox-ensure', 'toolchain-reconcile'] as const) {
    it(`${phase}: preserves the stopped row and replacement session without an error stream`, async () => {
      const { execution, store, lease, buffer } = await running()
      const opened = deferred(),
        finish = deferred()
      runnerSpy = spyOn(runners, 'createRunner').mockResolvedValue({
        run: async () => {
          try {
            await new AdmissionScope(store, lease).runEffect({ phase, resourceKey: 'sandbox:test' }, async () => {
              opened.resolve()
              await finish.promise
            })
          } catch (error) {
            throw markExecutionStartupFailure(attachAdmissionLeaseToError(error, lease))
          }
        },
      } as Awaited<ReturnType<typeof runners.createRunner>>)
      const run = execution.run()
      let disposed = 0
      try {
        await opened.promise
        await execution.requestStopWithSignal()
        await handleControlSignal({ action: 'stop', agentId: agent.id, executionId: execution.id })
        const stopped = await Execution.mustFind(execution.id)
        expect(stopped.status).toBe('stopped')
        const replacement = await agent.queueExecution({ message: 'Next turn' })
        expect(await replacement.start()).toBe(true)
        releaseSessionReservation(agent.id, execution.id)
        expect(reserveSession(agent.id, replacement.id)).toBe(true)
        const session = {
          dispose: () => {
            disposed++
          },
        } as AgentSession
        registerSession(agent.id, {
          session,
          executionId: replacement.id,
          agentId: agent.id,
          buffer: new StreamBuffer(),
        } as Parameters<typeof registerSession>[1])
        finish.resolve()
        await run
        const final = await Execution.mustFind(execution.id)
        expect(final.status).toBe('stopped')
        expect(final.endedAt).toEqual(stopped.endedAt)
        expect(final.error).toBeNull()
        expect(final.failureClass).toBeNull()
        expect(buffer.status).toBe('done')
        expect(buffer.subscribe(() => {})).not.toContainEqual(expect.objectContaining({ type: 'error' }))
        expect(getSession(agent.id)?.session).toBe(session)
        expect(disposed).toBe(0)
        expect((await Agent.mustFind(agent.id)).status).toBe('active')
      } finally {
        finish.resolve()
        await run
      }
    })
  }

  it('the failure CAS preserves a stop that lands after the preliminary read', async () => {
    const { execution, lease, buffer } = await running()
    runnerSpy = spyOn(runners, 'createRunner').mockRejectedValue(
      markExecutionStartupFailure(attachAdmissionLeaseToError(new Error('late startup failure'), lease))
    )
    const originalFail = execution.fail.bind(execution)
    const fail = spyOn(execution, 'fail').mockImplementation(async (...args) => {
      await (await Execution.mustFind(execution.id)).stop()
      return originalFail(...args)
    })
    try {
      await execution.run()
      expect(fail).toHaveBeenCalledTimes(1)
      const final = await Execution.mustFind(execution.id)
      expect(final.status).toBe('stopped')
      expect(final.error).toBeNull()
      expect(buffer.status).toBe('done')
      expect(buffer.subscribe(() => {})).not.toContainEqual(expect.objectContaining({ type: 'error' }))
    } finally {
      fail.mockRestore()
    }
  })

  it('a foreign takeover is still refused even when the execution is stopped', async () => {
    const { execution, lease } = await running()
    await execution.stop()
    await db
      .update(executionAdmissionReservations)
      .set({ ownerIncarnation: crypto.randomUUID() })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    runnerSpy = spyOn(runners, 'createRunner').mockRejectedValue(
      markExecutionStartupFailure(
        attachAdmissionLeaseToError(new Error('Admission effect was revoked or superseded'), lease)
      )
    )
    await expect(execution.run()).rejects.toThrow('revoked or superseded')
    expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
  })

  it('startup cleanup preserves another execution reservation and session', () => {
    const old = crypto.randomUUID(),
      next = crypto.randomUUID()
    expect(reserveSession(agent.id, next)).toBe(true)
    removeSessionForExecution(agent.id, old)
    expect(isSessionReserved(agent.id, next)).toBe(true)
    let disposed = 0
    const session = {
      dispose: () => {
        disposed++
      },
    } as AgentSession
    registerSession(agent.id, { session, executionId: next } as Parameters<typeof registerSession>[1])
    removeSessionForExecution(agent.id, old)
    expect(getSession(agent.id)?.session).toBe(session)
    expect(disposed).toBe(0)
    removeSessionForExecution(agent.id, next)
    expect(getSession(agent.id)).toBeUndefined()
    expect(disposed).toBe(1)
  })
})
