import { queryKeys, type ContinueHaltedActionsResult } from '@ficus/client-core'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { PendingAction } from '@ficus/shared'

/**
 * Cache settling after an action succeeds: drop the resolved action from the
 * pending list at once, then refetch exactly the query families the web app
 * refetches for the same action (ActionItem.completeAction,
 * AgentQuestionCard.settleQuestion, WorkStreamDetailModal's wait resolution,
 * WorkflowReviewCallout.useRefresh, WorkStreamPauseControls, ActionCenterContent).
 */

/** Pending-action ids, as the server builds them (apps/core/src/services/agents/actions.ts). */
export const actionIds = {
  squadQuestion: (agentId: string) => `squad-question:${agentId}`,
  agentQuestion: (questionId: string) => `agent-question:${questionId}`,
  streamWait: (kind: 'review' | 'blocked', workStreamId: string, waitId: string) =>
    `workstream-${kind}:${workStreamId}:${waitId}`,
}

export function removePendingActions(queryClient: QueryClient, ids: Iterable<string>) {
  const drop = new Set(ids)
  queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), (current) =>
    current?.filter((action) => !drop.has(action.id))
  )
}

function invalidateAll(queryClient: QueryClient, keys: QueryKey[]) {
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))).then(() => undefined)
}

/** Squad question answered by message: only the pending list changes. */
export function settleSquadQuestion(queryClient: QueryClient, agentId: string) {
  removePendingActions(queryClient, [actionIds.squadQuestion(agentId)])
  return invalidateAll(queryClient, [queryKeys.actions.pending()])
}

/** AgentQuestionCard's reconcile: the question lists and the pending list. */
export function reconcileAgentQuestions(queryClient: QueryClient) {
  return invalidateAll(queryClient, [queryKeys.agentQuestions.all, queryKeys.actions.pending()])
}

/** Answered / dismissed agent question (AgentQuestionCard.settleQuestion). */
export function settleAgentQuestion(queryClient: QueryClient, questionId: string) {
  removePendingActions(queryClient, [actionIds.agentQuestion(questionId)])
  return reconcileAgentQuestions(queryClient)
}

/** An agent-bound action completed (agent-question / agent-error in ActionItem.completeAction). */
export function settleAgentAction(
  queryClient: QueryClient,
  {
    actionId,
    agentId,
    squadId,
    question,
  }: { actionId: string; agentId: string; squadId: string | null; question: boolean }
) {
  removePendingActions(queryClient, [actionId])
  const keys: QueryKey[] = [
    queryKeys.actions.pending(),
    queryKeys.agents.detail(agentId),
    queryKeys.agents.activeExecution(agentId),
    queryKeys.agents.listPrefix(),
  ]
  if (squadId) keys.push(queryKeys.squads.agents(squadId))
  if (question) keys.push(queryKeys.agentQuestions.all)
  return invalidateAll(queryClient, keys)
}

/** A review / manual wait resolved (ActionItem.completeAction + WorkStreamDetailModal). */
export function settleStreamWait(
  queryClient: QueryClient,
  {
    workStreamId,
    squadId,
    waitId,
    kind,
  }: { workStreamId: string; squadId: string; waitId: string; kind: 'review' | 'blocked' }
) {
  removePendingActions(queryClient, [actionIds.streamWait(kind, workStreamId, waitId)])
  return invalidateAll(queryClient, [
    queryKeys.actions.pending(),
    queryKeys.squads.workStreamDetail(workStreamId),
    queryKeys.squads.workStreams(squadId),
    queryKeys.squads.allWorkStreams(),
    queryKeys.squads.activeWorkStreamsPrefix(),
    [...queryKeys.squads.all, 'doneWorkStreams'],
  ])
}

/** A workflow gate decided or delivery finished (WorkflowReviewCallout.useRefresh). */
export function refreshWorkflow(queryClient: QueryClient, workStreamId: string) {
  return invalidateAll(queryClient, [
    queryKeys.workflows.all,
    queryKeys.squads.all,
    queryKeys.squads.workStreamDetail(workStreamId),
    queryKeys.actions.pending(),
  ])
}

/** Pause / resume / park (WorkStreamPauseControls). */
export function refreshAfterPause(queryClient: QueryClient) {
  return invalidateAll(queryClient, [queryKeys.squads.all, queryKeys.workflows.all, queryKeys.agents.all])
}

/** "Continue all" (ActionCenterContent.AgentErrorSection). */
export function settleContinueAll(queryClient: QueryClient, result: ContinueHaltedActionsResult) {
  removePendingActions(queryClient, [...result.resumedActionIds, ...result.staleActionIds])
  return invalidateAll(queryClient, [queryKeys.actions.pending(), queryKeys.agents.listPrefix()])
}
