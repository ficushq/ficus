import { useEffect, useMemo, useState } from 'react'
import { FarmScreen } from '../farm/FarmScreen'
import { ActionsApiProvider, type ActionsApi } from '../actions'
import { makeStream } from '../farm/testFixtures'
import { SAMPLE_FARMER_QUESTION, SAMPLE_QUESTION, sampleFarm } from './sampleFarm'

/** Actions in the demo succeed without a server and log what they would have sent. */
function demoActionsApi(): ActionsApi {
  const ok =
    (name: string) =>
    async (...args: unknown[]) => {
      console.info(`[demo] ${name}`, ...args)
      return undefined as never
    }
  return {
    getAgentQuestions: async (agentId) =>
      [SAMPLE_QUESTION, SAMPLE_FARMER_QUESTION].filter((q) => q.agentId === agentId),
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
  // ?demo=moves has robots clock off (back to the hut) and on again (out to their plant) in turn.
  const [shift, setShift] = useState(0)
  useEffect(() => {
    if (mode !== 'moves') return
    const timer = window.setInterval(() => setShift((n) => n + 1), 4500)
    return () => window.clearInterval(timer)
  }, [mode])
  const shifted = useMemo(() => {
    if (!shift) return base
    const resting = new Set([shift % 2 ? 'w-hal' : null, (shift >> 1) % 2 ? 'w-ada' : null])
    return { ...base, agents: base.agents.map((a) => (resting.has(a.id) ? { ...a, status: 'idle' as const } : a)) }
  }, [base, shift])
  const input = useMemo(() => {
    if (!planted) return shifted
    const fresh = Array.from({ length: planted }, (_, n) => {
      const who = PLANTERS[n % PLANTERS.length]!
      return makeStream({ id: `demo-new-${n}`, status: 'queued', ...who })
    })
    return { ...shifted, streams: [...shifted.streams, ...fresh] }
  }, [shifted, planted])
  const api = useMemo(() => demoActionsApi(), [])
  return (
    <ActionsApiProvider api={api}>
      <FarmScreen input={input} live="live" />
    </ActionsApiProvider>
  )
}
