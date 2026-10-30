// Isolated synthetic state only: a review gate whose producing agent is chatted with inline, and an
// amendment that arrives while the review is open. Unexpected network requests fail in the runner.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-react'
import {
  advanceWorkflowRun,
  createBlankWorkflow,
  createWorkflowRun,
  type Message,
  type WorkflowAttemptAttachment,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { ChatView } from '../../src/components/ChatView'
import { WorkflowReviewModal } from '../../src/components/WorkflowReviewModal'
import { ReviewConversationContext, type ReviewConversationProps } from '../../src/components/WorkflowReviewChat'
import { queryKeys } from '../../src/queryKeys'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'

declare global {
  interface Window {
    amend: () => void
    lastSendOptions?: unknown
  }
}

const params = new URLSearchParams(location.search)
// Each case starts as a first visit: no remembered revisions or drafts from the previous case.
sessionStorage.clear()
applyResolvedTheme(document.documentElement, FICUS_THEME, params.has('dark') ? 'dark' : 'light')

const sentence = (topic: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `The ${topic} keeps the existing reader available during step ${index + 1} of the staged rollout.`
  ).join(' ')
// Field lengths follow a real design approval gate: a short decision and longer effect and risks.
const brief = {
  decision: 'Approve the staging cache migration design, which keeps the existing reader during rollback.',
  recommendation: `Approve because the fallback has been tested. ${sentence('fallback', 8)}`,
  approvalEffect: `Approval permits implementation for \`cache-stage-example-01\` only. Production deployment and deletion remain forbidden. ${sentence('approval', 14)}`,
  risks: `Two temporary read paths increase maintenance work. ${sentence('risk review', 9)}`,
}
const definition = createBlankWorkflow()
definition.steps[0]!.outcomes.completed = { next: 'gate' }
definition.steps.push({
  id: 'gate',
  kind: 'human-approval',
  name: 'Design approval',
  instructions: 'Review the staging design before implementation starts.',
  output: 'Decision.',
  approver: 'reviewers',
  outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'execute' } },
})
let state = createWorkflowRun(definition)
state = advanceWorkflowRun(state, {
  action: 'complete',
  expectedVersion: 0,
  attemptId: 1,
  outcome: 'completed',
  evidence: 'Detailed audit handoff. The staging design and fallback tests are attached, commit 1a2b3c4.',
  decisionBrief: brief,
})
const file = (id: string, path: string, revision = 1): WorkflowAttemptAttachment => ({
  id,
  attemptId: 1,
  filename: path.split('/').pop()!,
  path,
  contentType: 'text/markdown',
  byteSize: 90,
  createdAt: '2026-10-30T10:00:00Z',
  revision,
})
const gateWait = {
  id: 'gate-wait',
  workStreamId: 'chat-fixture',
  type: 'manual',
  workflowHumanGate: true,
  resolutionHandler: 'workflow',
  flowAttemptId: 2,
  message: 'Review the staging design before implementation starts.',
  openedAt: '2026-10-30T10:00:00Z',
} as WorkStreamWait
const stream = {
  id: 'chat-fixture',
  number: 42,
  squadId: 'fixture-squad',
  title: 'Staging cache migration design',
  status: 'active',
  agentIds: [],
  assignedReviewerIds: [],
  metadata: {},
  openWaits: [gateWait],
} as unknown as WorkStream
const detail: WorkflowRunDetail = {
  workStreamId: stream.id,
  source: {},
  state,
  version: state.version,
  attemptAgents: { '1': 'design-agent' },
  openWaits: [gateWait],
  attachments: { '1': [file('design', 'docs/staging-design.md'), file('old', 'docs/old-notes.md')] },
}
const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, staleTime: Infinity, retry: false } } })
cache.setQueryData(queryKeys.workflows.run(stream.id), detail)
cache.setQueryData(queryKeys.squads.list(), [])
cache.setQueryData(queryKeys.squads.workStreamDetail(stream.id), stream)
cache.setQueryData(queryKeys.auth.permissions(stream.squadId), {
  permissions: ['workstreams:review', 'agents:run'],
  identity: { type: 'user', userId: 'synthetic-reviewer' },
})

window.amend = () => {
  const amended = structuredClone(detail)
  const source = amended.state.attempts[0]!
  Object.assign(source, {
    earlierResults: [
      {
        revision: 1,
        version: source.settledVersion,
        evidence: source.evidence,
        decisionBrief: source.decisionBrief,
        attachmentIds: ['design', 'old'],
      },
    ],
    resultRevision: 2,
    resultRevisedVersion: amended.version + 1,
    resultRevisedAt: new Date().toISOString(),
    evidence: 'Revised audit handoff with the rollback note the reviewer asked for, commit 5d6e7f8.',
    attachmentIds: ['design-2', 'rollback'],
    decisionBrief: {
      value: {
        ...brief,
        risks: `Two temporary read paths increase maintenance work. A rollback note now explains how to return to the single reader. ${sentence('risk review', 6)}`,
      },
      submittedVersion: amended.version + 1,
      contexts: [],
    },
  })
  amended.version += 1
  amended.state.version += 1
  amended.attachments = {
    '1': [file('design-2', 'docs/staging-design.md', 2), file('rollback', 'docs/rollback.md', 2)],
  }
  amended.earlierAttachments = { '1': [file('design', 'docs/staging-design.md'), file('old', 'docs/old-notes.md')] }
  cache.setQueryData(queryKeys.workflows.run(stream.id), amended)
}

// A long synthetic transcript, so the chat must scroll on its own beside the pinned decision.
const start = Date.parse('2026-10-30T10:05:00Z')
const items: RenderItem[] = Array.from({ length: 24 }, (_, index) => {
  const message: Message = {
    id: `m${index}`,
    role: index % 2 ? 'assistant' : 'human',
    content:
      index % 2
        ? `The fallback reader stays enabled until the staging checks pass. ${sentence('answer', 2)}`
        : 'Why does the rollout keep the existing reader during rollback?',
    metadata: null,
    createdAt: new Date(start + index * 60_000).toISOString(),
  }
  return { kind: 'persisted', id: message.id, message, mergedFrom: [message], blocks: [] }
})

/** The real chat view with synthetic messages; sending records what the review attached. */
function FixtureConversation({ agentId, sendOptions, placeholder }: ReviewConversationProps) {
  return (
    <ChatView
      items={items}
      agentId={agentId}
      placeholder={placeholder}
      onSend={() => {
        window.lastSendOptions = sendOptions()
      }}
      dependencies={{ useImageSrcsHook: () => ({}), useVoiceEnabledHook: () => false }}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        <ReviewConversationContext.Provider value={FixtureConversation}>
          <WorkflowReviewModal stream={stream} attemptId={2} onClose={() => {}} />
        </ReviewConversationContext.Provider>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
