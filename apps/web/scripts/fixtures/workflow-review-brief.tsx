// Isolated synthetic state only. Unexpected network requests fail in the browser runner.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  createBlankWorkflow,
  createWorkflowRun,
  advanceWorkflowRun,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { WorkflowDecision } from '../../../farm/src/actions/WorkflowDecision'
import { ActionsApiProvider } from '../../../farm/src/actions/ActionsApiProvider'
import type { ActionsApi } from '../../../farm/src/actions/api'
import { WorkflowReviewModal } from '../../src/components/WorkflowReviewModal'
import { WorkStreamStatusBadges } from '../../src/components/WorkStreamStatusBadges'
import { queryKeys } from '../../src/queryKeys'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'
const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'first'
const farm = params.get('surface') === 'farm'
if (farm) {
  await import('@fontsource-variable/fraunces')
  await import('@fontsource-variable/instrument-sans')
  await import('@fontsource-variable/jetbrains-mono')
  await import('../../../farm/src/skins/nostalgic/theme.css')
  await import('../../../farm/src/styles.css')
  await import('../../../farm/src/actions/actions.css')
}
applyResolvedTheme(document.documentElement, FICUS_THEME, params.has('dark') ? 'dark' : 'light')
const definition = createBlankWorkflow()
definition.steps[0]!.outcomes.completed = { next: 'gate' }
definition.steps[0]!.outcomes.recheck = { returnTo: 'gate', afterRework: 'return-to-requester' }
definition.steps.push({
  id: 'gate',
  kind: 'human-approval',
  name: 'Staging design review',
  instructions: 'Review the staging design before implementation starts.',
  output: 'Decision.',
  approver: 'reviewers',
  outcomes: { approved: { next: 'second' }, retry: { returnTo: 'execute', afterRework: 'return-to-requester' } },
})
definition.steps.push({
  id: 'second',
  kind: 'human-approval',
  name: 'Rollout review',
  instructions: 'Review the rollout separately. Earlier approval does not authorize deployment.',
  output: 'Decision.',
  approver: 'reviewers',
  outcomes: { approved: { next: 'finish' } },
})
if (mode === 'human-return')
  definition.steps.find((step) => step.id === 'second')!.outcomes.recheck = {
    returnTo: 'gate',
    afterRework: 'return-to-requester',
  }
const brief = {
  decision: 'Approve the staging migration design.',
  recommendation: 'Approve because the tested fallback keeps existing readers available.',
  approvalEffect: `Approval permits implementation for \`cache-stage-${'example-'.repeat(22)}01\` only. Production deployment and deletion remain forbidden. Sequencing holds must clear before execution.`,
  risks: 'Two temporary read paths increase maintenance work. A failed migration can delay staging tests.',
}
if (mode === 'return') {
  // Finish is diverted to the requesting producer; omit the now-unreachable rollout gate.
  definition.steps.find((s) => s.id === 'gate')!.outcomes.approved = { next: 'finish' }
  definition.steps = definition.steps.filter((s) => s.id !== 'second')
}
if (mode.startsWith('mixed-')) {
  definition.steps[0]!.outcomes.completed = { parallel: ['left', 'right'], join: 'gate' }
  definition.steps.push(
    { ...definition.steps[0]!, id: 'left', outcomes: { completed: { next: 'gate' } } },
    {
      id: 'right',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Review the staging prerequisite.',
      output: 'Decision.',
      outcomes: { approved: { next: 'gate' } },
    }
  )
}
if (mode.startsWith('decision-')) {
  definition.steps[0]!.outcomes.completed = { next: 'choice' }
  definition.steps[0]!.outcomes.design = { next: 'gate' }
  definition.steps.push({
    id: 'choice',
    name: 'Staging option',
    kind: 'decision',
    instructions: 'Choose the staging option; production remains forbidden.',
    input: ['incoming-results'],
    questions: { ready: { type: 'yesno', instructions: 'Is the staging option ready?' } },
    routes: [],
    outcomes: { approved: { next: 'finish' } },
  })
}
let state = createWorkflowRun(definition)
state = advanceWorkflowRun(state, {
  action: 'complete',
  expectedVersion: 0,
  attemptId: 1,
  outcome: 'completed',
  evidence:
    'Detailed audit handoff. The staging design and fallback tests are attached. No production operation is authorized.',
  decisionBrief: mode === 'decision-none' ? undefined : brief,
})
if (['repeat', 'blocked', 'return', 'legacy-queued'].includes(mode)) {
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: state.version,
    attemptId: 2,
    outcome: 'retry',
    evidence: 'Retain the existing staging reader after rollback.',
  })
  if (mode === 'legacy-queued')
    state = advanceWorkflowRun(state, {
      action: 'revise',
      expectedVersion: state.version,
      attemptId: 3,
      active: 'keep',
      reason: 'Queue the next synthetic review.',
      operations: [{ op: 'set-limits', limits: { ...state.definition.limits, maxStepAttempts: 1 } }],
    })
  state = advanceWorkflowRun(state, {
    ...(mode === 'return'
      ? {
          action: 'return',
          targetStepId: 'gate',
          resumeAt: 'execute',
          feedback: 'Review the revised staging scope before resuming.',
        }
      : {
          action: 'complete',
          outcome: 'completed',
          evidence:
            'Revised audit handoff with fallback verification and two interrupted test runs. See the attached design.',
        }),
    expectedVersion: state.version,
    attemptId: 3,
    decisionBrief: {
      ...brief,
      changesSinceLastReview:
        'The previous review requested a retained staging reader. Two test executions stopped before changing data. The new design keeps that reader during rollback; production scope has not changed.',
    },
  })
}
if (mode === 'legacy-queued') {
  delete state.pendingStarts![0]!.reviewBrief
  for (const source of state.attempts) {
    delete source.decisionBrief
    delete source.reviewBrief
  }
  state = advanceWorkflowRun(state, {
    action: 'revise',
    expectedVersion: state.version,
    attemptId: null,
    active: 'keep',
    reason: 'Admit the pre-deploy queued review.',
    operations: [{ op: 'set-limits', limits: { ...state.definition.limits, maxStepAttempts: 5 } }],
  })
}
if (mode.startsWith('mixed-')) {
  for (const id of mode === 'mixed-agent-first' ? [2, 3] : [3, 2])
    state = advanceWorkflowRun(state, {
      action: 'complete',
      expectedVersion: state.version,
      attemptId: id,
      outcome: id === 2 ? 'completed' : 'approved',
      evidence: 'Synthetic join branch handoff.',
      ...(id === 2 ? { decisionBrief: { ...brief, decision: 'Approve the joined staging design.' } } : {}),
    })
}
if (mode.startsWith('decision-'))
  state.attempts.at(-1)!.decision = {
    status: 'unconfigured',
    matched: 'unavailable',
    awaitingPerson: true,
    decidedAt: '2026-10-29T00:00:00Z',
  }
if (mode === 'restarted')
  state = advanceWorkflowRun(state, {
    action: 'revise',
    expectedVersion: state.version,
    attemptId: state.activeAttemptId,
    active: 'restart',
    reason: 'Start a fresh review for replacement scope.',
    operations: [
      {
        op: 'put-step',
        step: {
          ...definition.steps.find((s) => s.id === 'gate')!,
          instructions:
            'Review only the replacement staging scope. The previous review session does not authorize this scope.',
        },
      },
    ],
  })
if (mode === 'carried' || mode === 'human-return')
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: state.version,
    attemptId: 2,
    outcome: 'approved',
    evidence: '',
  })
if (mode === 'human-return')
  state = advanceWorkflowRun(state, {
    action: 'return',
    expectedVersion: state.version,
    attemptId: state.activeAttemptId,
    targetStepId: 'gate',
    resumeAt: 'second',
    feedback: 'Recheck the staging prerequisite before rollout review.',
  })
if (mode === 'none') state.attempts.at(-1)!.reviewBrief = { kind: 'none' }
if (mode === 'legacy') {
  delete state.attempts[0]!.decisionBrief
  delete state.attempts[1]!.reviewBrief
}
const attempt = state.attempts.find((a) => a.id === state.activeAttemptId)!
const gate = {
  id: 'gate-wait',
  workStreamId: 'brief-fixture',
  type: 'manual',
  workflowHumanGate: true,
  resolutionHandler: 'workflow',
  flowAttemptId: attempt.id,
  message: attempt.step!.instructions,
  openedAt: '2026-10-29T10:00:00Z',
} as WorkStreamWait
const blockers =
  mode === 'blocked'
    ? ['prerequisite-a', 'prerequisite-b'].map((id, index) => ({
        ...gate,
        id,
        workflowHumanGate: false,
        resolutionHandler: undefined,
        flowAttemptId: null,
        actor: 'owner' as const,
        message: `Wait for staging prerequisite ${index + 1}. This review does not release the sequencing hold.`,
      }))
    : []
const stream = {
  id: 'brief-fixture',
  number: 42,
  squadId: 'fixture-squad',
  title: 'Staging migration design',
  status: 'active',
  agentIds: [],
  assignedReviewerIds: [],
  metadata: {},
  openWaits: [gate, ...blockers],
} as unknown as WorkStream
const sourceId = ['repeat', 'blocked', 'return', 'legacy-queued'].includes(mode) ? 3 : mode.startsWith('mixed-') ? 2 : 1
const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, staleTime: Infinity, retry: false } } })
const detail: WorkflowRunDetail = {
  workStreamId: stream.id,
  source: {},
  state,
  version: state.version,
  attemptAgents: {},
  openWaits: stream.openWaits,
  attachments: {
    [sourceId]: [
      {
        id: 'synthetic-design',
        attemptId: sourceId,
        filename: 'staging-design.md',
        path: 'docs/staging-design.md',
        contentType: 'text/markdown',
        byteSize: 90,
        createdAt: '2026-10-29T10:00:00Z',
      },
    ],
  },
}
cache.setQueryData(queryKeys.workflows.run(stream.id), detail)
cache.setQueryData(queryKeys.squads.list(), [])
cache.setQueryData(queryKeys.squads.workStreamDetail(stream.id), stream)
cache.setQueryDefaults(['workflow-review-attachment'], { enabled: true })
cache.setQueryData(queryKeys.auth.permissions(stream.squadId), {
  permissions: ['workstreams:review'],
  identity: { type: 'user', userId: 'synthetic-reviewer' },
})
Object.assign(window, {
  clearReviewBlockers: () => {
    cache.setQueryData(queryKeys.workflows.run(stream.id), { ...detail, openWaits: [gate] })
    cache.setQueryData(queryKeys.squads.workStreamDetail(stream.id), { ...stream, openWaits: [gate] })
  },
})
const farmApi = {
  workflowRun: async () => detail,
  getWorkStream: async () => stream,
  getMyPermissions: async () => ({
    permissions: ['workstreams:review'],
    identity: { type: 'user', userId: 'synthetic-reviewer' },
  }),
  downloadWorkflowAttachment: async () =>
    new TextEncoder().encode('# Staging design attachment\n\nKeep the existing reader during rollback.'),
} as ActionsApi
export function Preview() {
  const { data: current = stream } = useQuery({
    queryKey: queryKeys.squads.workStreamDetail(stream.id),
    enabled: false,
    queryFn: async () => stream,
  })
  return farm ? (
    <main style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      <ActionsApiProvider api={farmApi}>
        <WorkflowDecision workStreamId={stream.id} stream={current} />
      </ActionsApiProvider>
    </main>
  ) : (
    <>
      <WorkStreamStatusBadges workStream={current} />
      <WorkflowReviewModal stream={current} attemptId={attempt.id} onClose={() => {}} />
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <Preview />
    </QueryClientProvider>
  </MemoryRouter>
)
