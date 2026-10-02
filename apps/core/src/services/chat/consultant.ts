import type { DbTx } from '../../db'
import type { ConsultantOrigin } from '@ficus/shared'
import { Agent } from '../../entities/Agent'
import { ChatIdempotencyConflictError } from './consultant-idempotency'

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === 'object') {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}

function matchesConsultantScope(agent: Agent, squadId: string): boolean {
  const scope = (agent.context as { scope?: { type?: string; id?: string } }).scope
  return (
    agent.agentTypeId === 'consultant' &&
    agent.squadId === squadId &&
    agent.persist === false &&
    agent.ownerUserId === null &&
    scope?.type === 'consultant' &&
    scope.id === squadId
  )
}

export async function findOrCreateConsultant(
  id: string,
  squadId: string,
  origin: ConsultantOrigin,
  authorizeInsert?: (tx: DbTx) => Promise<void>
): Promise<Agent> {
  const existing = await Agent.find(id)
  if (existing) {
    if (!matchesConsultantScope(existing, squadId)) throw new ChatIdempotencyConflictError()
    return existing
  }

  try {
    return await Agent.create(
      {
        id,
        agentTypeId: 'consultant',
        squadId,
        context: { scope: { type: 'consultant', id: squadId }, origin },
        persist: false,
      },
      authorizeInsert
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const winner = await Agent.find(id)
    if (!winner || !matchesConsultantScope(winner, squadId)) throw new ChatIdempotencyConflictError()
    return winner
  }
}
