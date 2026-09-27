import { resolveActingUser } from '../services/rbac'
import { Hono } from 'hono'
import { hasAgentResourcePermission, type Identity } from '../services/rbac'
import { Agent } from '../entities/Agent'
import {
  getAgentQuestion,
  answerAgentQuestion,
  dismissAgentQuestion,
  listAgentQuestions,
  retryAgentQuestionAnswerDelivery,
  setQuestionBlocking,
} from '../services/agents/questions'
import { reconcileAcceptedQuestionAnswerFailuresOnce } from '../services/agents/question-answer-delivery'
import { acknowledgeQuestionDeliveryFailure } from '../services/agents/question-delivery-acknowledgement'
import { canReceiveAgentQuestionAttention } from '../services/agents/pending-action-policy'
import { loadUserAttention } from '../services/attention/resolver'
import { canAnswerAgentQuestion } from '../services/agents/question-authorization'

export const agentQuestionsRouter = new Hono()
  // GET /api/agent-questions/by-agent/:agentId?status=open|answered — for the conversation view.
  // `answered` is the terminal history bucket and includes answered and dismissed questions.
  //
  // Chat/history visibility follows canonical READ access to the current agent resource (the
  // agent's owner, or agents:read on its squad). It deliberately does NOT consult attention
  // routing (direct recipients, watched squads/work streams) — that governs Action Center/push
  // attention, not whether an authorized reader can see an agent's own question history.
  .get('/by-agent/:agentId', async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const agent = await Agent.find(c.req.param('agentId'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    c.set('authzChecked', true)
    if (!(await hasAgentResourcePermission(identity, agent, 'agents:read'))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const status = c.req.query('status')
    const requestedStatus = status === 'open' || status === 'answered' ? status : undefined
    const questions =
      requestedStatus === 'answered'
        ? await listAgentQuestions(agent.id, { statuses: ['answered', 'dismissed'] })
        : requestedStatus === 'open'
          ? await listAgentQuestions(agent.id, { status: 'open' })
          : await listAgentQuestions(agent.id)
    return c.json(questions)
  })

  // DELETE /api/agent-questions/:id { reason? } — dismiss an open question without answering it.
  // Dismissal deliberately sends nothing to the asking agent, so its lifecycle state is irrelevant.
  .delete('/:id', async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity || (identity.type !== 'user' && identity.type !== 'agent')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const id = c.req.param('id')
    const question = await getAgentQuestion(id)
    if (!question) return c.json({ error: 'Question not found' }, 404)
    // Capture the scope before authorization so the transaction can reject any intervening move
    // or ownership change rather than committing under stale authority.
    const target = await Agent.find(question.agentId)
    if (!target || !(await canAnswerAgentQuestion(identity, question, { allowTerminatedAgent: true, target }))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    c.set('authzChecked', true)

    let reason: string | undefined
    try {
      const body = (await c.req.json()) as { reason?: unknown }
      if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim()
    } catch {
      reason = undefined
    }
    const dismissedBy =
      identity.type === 'agent'
        ? { type: 'agent' as const, agentId: identity.agentId }
        : { type: 'user' as const, userId: identity.userId }
    const updated = await dismissAgentQuestion(id, {
      dismissedBy,
      reason,
      expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
    })
    if (!updated) return c.json({ error: 'Question is not open' }, 409)
    return c.json(updated)
  })

  // POST /api/agent-questions/:id/answer — record the answer; it's delivered to the agent as an inbox
  // message that wakes it.
  .post('/:id/answer', async (c) => {
    const identity = await resolveActingUser(c.get('identity'))
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const id = c.req.param('id')
    const question = await getAgentQuestion(id)
    if (!question) return c.json({ error: 'Question not found' }, 404)

    // Answering delivers a message to the agent (it wakes the agent), so it requires the same
    // permission as sending a message: the agent's current owner, or agents:run on its current squad.
    const target = await Agent.find(question.agentId)
    if (!target || target.status === 'terminated' || target.pendingDormancyAt) {
      return c.json({ error: 'Asking agent is terminating or terminated' }, 409)
    }
    const allowed = await canAnswerAgentQuestion(identity, question)
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)

    const body = (await c.req.json()) as { answer?: unknown }
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (!answer) return c.json({ error: 'answer is required' }, 400)

    const updated = await answerAgentQuestion(id, answer, identity.userId, {
      expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
    })
    if (!updated) return c.json({ error: 'Question already answered' }, 409)
    return c.json(updated)
  })

  .post('/:id/retry-delivery', async (c) => {
    const identity = await resolveActingUser(c.get('identity'))
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const id = c.req.param('id')
    const question = await getAgentQuestion(id)
    if (!question) return c.json({ error: 'Question not found' }, 404)
    const target = await Agent.find(question.agentId)
    if (!target || !(await canAnswerAgentQuestion(identity, question, { allowTerminatedAgent: true, target }))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    c.set('authzChecked', true)
    // Trust an accepted receipt before rejecting a now-terminated target or resending.
    if (await reconcileAcceptedQuestionAnswerFailuresOnce(id)) return c.json(await getAgentQuestion(id))
    if (!target || target.status === 'terminated' || target.pendingDormancyAt) {
      return c.json({ error: 'Asking agent is terminating or terminated' }, 409)
    }

    const updated = await retryAgentQuestionAnswerDelivery(id, {
      expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
    })
    if (!updated) return c.json({ error: 'Answer delivery is not failed', code: 'delivery_not_failed' }, 409)
    return c.json(updated)
  })

  // Acknowledge the current failed-delivery action only for the acting user. Never dismiss the
  // question itself (answer history and work-stream waits are independent of this attention row).
  .post('/:id/dismiss-delivery-failure', async (c) => {
    const identity = await resolveActingUser(c.get('identity'))
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const question = await getAgentQuestion(c.req.param('id'))
    if (!question) return c.json({ error: 'Question not found' }, 404)
    const attention = await loadUserAttention(identity.userId)
    if (!(await canReceiveAgentQuestionAttention(identity, question, { attention }))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    c.set('authzChecked', true)
    const body = await c.req.json<{ generation?: unknown }>()
    if (!Number.isSafeInteger(body?.generation) || (body?.generation as number) < 1) {
      return c.json({ error: 'generation (positive integer) is required' }, 400)
    }
    const acknowledged = await acknowledgeQuestionDeliveryFailure(
      question.id,
      identity.userId,
      body!.generation as number
    )
    if (!acknowledged) return c.json({ error: 'Delivery failure generation is no longer current' }, 409)
    return c.json({ acknowledged: true })
  })

  // POST /api/agent-questions/:id/blocking { blocking } — convert an open question to blocking
  // (opens `question` waits on the asking agent's work streams) or back to non-blocking (closes
  // them, `cleared`). Managers (agent identities with agents:run) and users may convert.
  .post('/:id/blocking', async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const id = c.req.param('id')
    const question = await getAgentQuestion(id)
    if (!question) return c.json({ error: 'Question not found' }, 404)

    const target = await Agent.find(question.agentId)
    if (!target || target.status === 'terminated' || target.pendingDormancyAt) {
      return c.json({ error: 'Asking agent is terminating or terminated' }, 409)
    }
    // Conversion authority is identical to answer authority: canonical current-agent
    // agents:run resource policy (squad RBAC over stored ownership; private owner-exclusive;
    // orphan fallback to global permission), with the expectedAgentScope fence re-checked
    // inside setQuestionBlocking's transaction.
    const allowed = await hasAgentResourcePermission(identity, target, 'agents:run')
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    c.set('authzChecked', true)

    const body = (await c.req.json()) as { blocking?: unknown }
    if (typeof body.blocking !== 'boolean') return c.json({ error: 'blocking (boolean) is required' }, 400)

    const updated = await setQuestionBlocking(id, body.blocking, {
      expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
    })
    if (!updated) return c.json({ error: 'Question already answered' }, 409)
    return c.json(updated)
  })
