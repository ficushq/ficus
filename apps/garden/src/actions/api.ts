import type { GardenClient } from '../api/client'

type C = GardenClient

/**
 * Every server call the garden's "Needs you" actions make, as one injectable
 * surface (see ActionsApiProvider) so component tests can pass stubs. Each
 * entry is typed from, and by default delegates to, the same @ficus/client-core
 * function the web app uses, so calls and payloads stay identical:
 *
 * - answer / dismiss / retry delivery: apps/web/src/api/agentQuestions.ts
 * - sendAgentMessage, continueHaltedActions: apps/web/src/api/agents.ts
 * - resolveWorkStreamWait: apps/web/src/api/squads.ts
 * - workflows.advance / finish / run: WorkflowReviewCallout.tsx, WorkflowRunPanel.tsx
 * - workStreams.pause / resume / park: WorkStreamPauseControls.tsx
 * - auth.getMyPermissions: apps/web/src/hooks/usePermissions.ts
 *
 * Everything the web uses for these actions is already on client-core, so no
 * raw `client.transport.request` calls are needed here.
 */
export interface ActionsApi {
  getAgentQuestions: C['agentQuestions']['getAgentQuestions']
  answerAgentQuestion: C['agentQuestions']['answerAgentQuestion']
  dismissAgentQuestion: C['agentQuestions']['dismissAgentQuestion']
  retryAgentQuestionAnswerDelivery: C['agentQuestions']['retryAgentQuestionAnswerDelivery']
  sendAgentMessage: C['agents']['sendMessage']
  continueHaltedActions: C['agents']['continueHaltedActions']
  resolveWorkStreamWait: C['squads']['resolveWorkStreamWait']
  getWorkStream: C['squads']['getWorkStream']
  workflowRun: C['workflows']['run']
  advanceWorkflow: C['workflows']['advance']
  finishWorkflow: C['workflows']['finish']
  pauseWorkStream: C['workStreams']['pause']
  resumeWorkStream: C['workStreams']['resume']
  parkWorkStream: C['workStreams']['park']
  getMyPermissions: C['auth']['getMyPermissions']
  /** Idempotency key for workflow commands (the web uses crypto.randomUUID()). */
  newRequestId: () => string
}

export function createActionsApi(c: GardenClient): ActionsApi {
  return {
    getAgentQuestions: (agentId, status) => c.agentQuestions.getAgentQuestions(agentId, status),
    answerAgentQuestion: (id, answer) => c.agentQuestions.answerAgentQuestion(id, answer),
    dismissAgentQuestion: (id, reason) => c.agentQuestions.dismissAgentQuestion(id, reason),
    retryAgentQuestionAnswerDelivery: (id) => c.agentQuestions.retryAgentQuestionAnswerDelivery(id),
    sendAgentMessage: (agentId, content, options) => c.agents.sendMessage(agentId, content, options),
    continueHaltedActions: (actionIds) => c.agents.continueHaltedActions(actionIds),
    resolveWorkStreamWait: (workStreamId, waitId, input) => c.squads.resolveWorkStreamWait(workStreamId, waitId, input),
    getWorkStream: (id) => c.squads.getWorkStream(id),
    workflowRun: (id) => c.workflows.run(id),
    advanceWorkflow: (id, command, requestId) => c.workflows.advance(id, command, requestId),
    finishWorkflow: (id, version) => c.workflows.finish(id, version),
    pauseWorkStream: (id, options) => c.workStreams.pause(id, options),
    resumeWorkStream: (id) => c.workStreams.resume(id),
    parkWorkStream: (id) => c.workStreams.park(id),
    getMyPermissions: (squadId) => c.auth.getMyPermissions(squadId),
    newRequestId: () => crypto.randomUUID(),
  }
}

/** A safe user-facing message (mirrors apps/web/src/lib/actionError.ts). */
export function actionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Action failed. Try again.'
}
