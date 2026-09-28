import { useEffect, useMemo, useState } from 'react'
import { FarmScreen } from '../farm/FarmScreen'
import { ActionsApiProvider, type ActionsApi } from '../actions'
import { makeStream } from '../farm/testFixtures'
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

/** Who plants what in ?demo=planting: farmers and consultants take turns starting new streams. */
const PLANTERS = [
  { squadId: 'sq-docs', creatorAgentId: 'c-lee', title: 'Draft the migration guide' },
  { squadId: 'sq-platform', creatorAgentId: 'mgr-platform', title: 'Tidy the job queue metrics' },
  { squadId: 'sq-mobile', creatorAgentId: 'mgr-mobile', title: 'Offline mode for the inbox' },
  { squadId: 'sq-platform', creatorAgentId: 'c-max', title: 'Onboarding checklist' },
] as const

export default function DemoFarm() {
  const mode = new URLSearchParams(window.location.search).get('demo')
  const base = useMemo(() => {
    const farm = sampleFarm()
    // ?demo=empty shows a brand-new instance with no squads yet.
    if (mode === 'empty')
      return { ...farm, squads: [], streams: [], agents: [], pendingActions: [], doneCount: 0, canceledCount: 0 }
    return farm
  }, [mode])
  // ?demo=planting starts a new work stream every few seconds, so its robot can be watched planting it.
  const [planted, setPlanted] = useState(0)
  useEffect(() => {
    if (mode !== 'planting') return
    const timer = window.setInterval(() => setPlanted((n) => (n < 8 ? n + 1 : n)), 7000)
    return () => window.clearInterval(timer)
  }, [mode])
  const input = useMemo(() => {
    if (!planted) return base
    const fresh = Array.from({ length: planted }, (_, n) => {
      const who = PLANTERS[n % PLANTERS.length]!
      return makeStream({ id: `demo-new-${n}`, status: 'queued', ...who })
    })
    return { ...base, streams: [...base.streams, ...fresh] }
  }, [base, planted])
  const api = useMemo(() => demoActionsApi(), [])
  return (
    <ActionsApiProvider api={api}>
      <FarmScreen input={input} live="live" />
    </ActionsApiProvider>
  )
}
