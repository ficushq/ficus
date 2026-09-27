import { useMemo } from 'react'
import { FarmScreen } from '../farm/FarmScreen'
import { ActionsApiProvider, type ActionsApi } from '../actions'
import { SAMPLE_QUESTION, sampleFarm } from './sampleFarm'

/** Actions in the demo succeed without a server and log what they would have sent. */
function demoActionsApi(): ActionsApi {
  const ok =
    (name: string) =>
    async (...args: unknown[]) => {
      console.info(`[demo] ${name}`, ...args)
      return undefined as never
    }
  return {
    getAgentQuestions: async (agentId) => (agentId === SAMPLE_QUESTION.agentId ? [SAMPLE_QUESTION] : []),
    answerAgentQuestion: ok('answerAgentQuestion'),
    dismissAgentQuestion: ok('dismissAgentQuestion'),
    retryAgentQuestionAnswerDelivery: ok('retryAgentQuestionAnswerDelivery'),
    sendAgentMessage: ok('sendAgentMessage'),
    continueHaltedActions: ok('continueHaltedActions'),
    resolveWorkStreamWait: ok('resolveWorkStreamWait'),
    getWorkStream: ok('getWorkStream'),
    workflowRun: ok('workflowRun'),
    advanceWorkflow: ok('advanceWorkflow'),
    finishWorkflow: ok('finishWorkflow'),
    pauseWorkStream: ok('pauseWorkStream'),
    resumeWorkStream: ok('resumeWorkStream'),
    parkWorkStream: ok('parkWorkStream'),
    getMyPermissions: async () => ({ permissions: ['*'], identity: { type: 'user', id: 'demo' } as never }),
    newRequestId: () => crypto.randomUUID(),
  }
}

export default function DemoFarm() {
  const input = useMemo(() => sampleFarm(), [])
  const api = useMemo(() => demoActionsApi(), [])
  return (
    <ActionsApiProvider api={api}>
      <FarmScreen input={input} live="live" />
    </ActionsApiProvider>
  )
}
