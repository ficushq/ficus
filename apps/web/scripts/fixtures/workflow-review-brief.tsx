// Isolated synthetic state only. Unexpected network requests fail in the browser runner.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createBlankWorkflow,
  createWorkflowRun,
  advanceWorkflowRun,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { WorkflowReviewModal } from '../../src/components/WorkflowReviewModal'
import { WorkStreamStatusBadges } from '../../src/components/WorkStreamStatusBadges'
import { queryKeys } from '../../src/queryKeys'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'
const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'first'
applyResolvedTheme(document.documentElement, FICUS_THEME, params.has('dark') ? 'dark' : 'light')
const definition = createBlankWorkflow()
definition.steps[0]!.outcomes.completed = { next: 'gate' }
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
const brief = {
  decision: 'Approve the staging migration design.',
  recommendation: 'Approve because the tested fallback keeps existing readers available.',
  approvalEffect: `Approval permits implementation for \`cache-stage-${'example-'.repeat(22)}01\` only. Production deployment and deletion remain forbidden. Sequencing holds must clear before execution.`,
  risks: 'Two temporary read paths increase maintenance work. A failed migration can delay staging tests.',
}
let state = createWorkflowRun(definition)
state = advanceWorkflowRun(state, {
  action: 'complete',
  expectedVersion: 0,
  attemptId: 1,
  outcome: 'completed',
  evidence:
    'Detailed audit handoff. The staging design and fallback tests are attached. No production operation is authorized.',
  decisionBrief: brief,
})
if (mode === 'repeat' || mode === 'blocked') {
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: state.version,
    attemptId: 2,
    outcome: 'retry',
    evidence: 'Retain the existing staging reader after rollback.',
  })
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: state.version,
    attemptId: 3,
    outcome: 'completed',
    evidence:
      'Revised audit handoff with fallback verification and two interrupted test runs. See the attached design.',
    decisionBrief: {
      ...brief,
      changesSinceLastReview:
        'The previous review requested a retained staging reader. Two test executions stopped before changing data. The new design keeps that reader during rollback; production scope has not changed.',
    },
  })
}
if (mode === 'carried')
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: state.version,
    attemptId: 2,
    outcome: 'approved',
    evidence: '',
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
const sourceId = mode === 'repeat' || mode === 'blocked' ? 3 : 1
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
cache.setQueryData(queryKeys.auth.permissions(stream.squadId), {
  permissions: ['workstreams:review'],
  identity: { type: 'user', userId: 'synthetic-reviewer' },
})
Object.assign(window, {
  clearReviewBlockers: () => cache.setQueryData(queryKeys.workflows.run(stream.id), { ...detail, openWaits: [gate] }),
})
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <WorkStreamStatusBadges workStream={stream} />
      <WorkflowReviewModal stream={stream} attemptId={attempt.id} onClose={() => {}} />
    </QueryClientProvider>
  </MemoryRouter>
)
