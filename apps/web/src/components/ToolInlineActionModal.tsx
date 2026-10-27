import { lazy, Suspense, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { workStreamRef } from '@ficus/shared'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { Modal } from './Modal'
import { MonitorDetailsModal } from './monitors/MonitorDetailsModal'
import type { AgentConversation } from './AgentConversationBody'
import { AgentQuestionCard } from './AgentQuestionCard'
import type { ToolInlineActionScope } from './ToolInlineActions'
import { ChatSkeleton, DocumentSkeleton } from './loading/Skeleton'

const LazyAgentConversation = lazy(() =>
  import('./AgentConversationBody').then((module) => ({ default: module.AgentConversation }))
)
const LazyMemoryFileViewer = lazy(() =>
  import('./memory/MemoryFileViewer').then((module) => ({ default: module.MemoryFileViewer }))
)
const LazyArtifactRenderer = lazy(() =>
  import('./artifacts/ArtifactRenderer').then((module) => ({ default: module.ArtifactRenderer }))
)

export interface ToolInlineActionModalProps {
  action: ToolInlineAction
  /** The chat the action came from; question and artifact targets open through its agent, memory notes its squad. */
  scope?: ToolInlineActionScope
  onClose: () => void
  dependencies?: {
    AgentConversationComponent?: typeof AgentConversation
    MonitorDetailsModalComponent?: typeof MonitorDetailsModal
  }
}

/**
 * Opens an inline action's target in place. Pull requests and local apps open in a new tab from the click
 * itself (see ChatView), so they never reach here.
 */
export function ToolInlineActionModal({ action, scope, onClose, dependencies }: ToolInlineActionModalProps) {
  switch (action.kind) {
    case 'monitor': {
      const MonitorModal = dependencies?.MonitorDetailsModalComponent ?? MonitorDetailsModal
      return <MonitorModal monitorId={action.monitorId} onClose={onClose} />
    }
    case 'subagent': {
      const Conversation = dependencies?.AgentConversationComponent ?? LazyAgentConversation
      return (
        <Modal isOpen onClose={onClose} title={`${action.subagentLabel} chat`} size="viewport" noChildPadding>
          <Suspense fallback={<ChatSkeleton label="Loading conversation" />}>
            <Conversation agentId={action.subagentId} embedded enableFullscreen={false} />
          </Suspense>
        </Modal>
      )
    }
    case 'question':
      return scope?.agentId ? (
        <QuestionModal agentId={scope.agentId} questionId={action.questionId} onClose={onClose} />
      ) : null
    case 'artifact':
      return scope?.agentId ? (
        <ArtifactModal agentId={scope.agentId} artifactId={action.artifactId} title={action.title} onClose={onClose} />
      ) : null
    case 'memory_note': {
      const squadId = action.squadId ?? scope?.squadId
      return squadId ? <MemoryNoteModal squadId={squadId} path={action.path} onClose={onClose} /> : null
    }
    case 'work_stream':
      return <OpenWorkStream reference={action.workStreamRef} fallbackSquadId={scope?.squadId} onClose={onClose} />
    default:
      return null
  }
}

/** The question an agent asked, answerable in place while open and read-only once answered or dismissed. */
function QuestionModal({ agentId, questionId, onClose }: { agentId: string; questionId: string; onClose: () => void }) {
  const questionsQuery = useQuery(queries.agentQuestions.byAgent(agentId))
  const question = questionsQuery.data?.find((candidate) => candidate.id === questionId)
  return (
    <Modal isOpen onClose={onClose} title="Agent question" closeOnEscape>
      {questionsQuery.isPending ? (
        <p className="text-sm text-muted">Loading question…</p>
      ) : questionsQuery.isError ? (
        <p className="text-sm text-muted">Unable to load this question.</p>
      ) : !question ? (
        <p className="text-sm text-muted">This question is no longer available.</p>
      ) : (
        <AgentQuestionCard question={question} embedded onAnswered={onClose} />
      )}
    </Modal>
  )
}

/** A published artifact, rendered with the artifact viewer the voice workspace uses. */
function ArtifactModal({
  agentId,
  artifactId,
  title,
  onClose,
}: {
  agentId: string
  artifactId: string
  title?: string
  onClose: () => void
}) {
  const contextQuery = useQuery(queries.artifacts.context(agentId, artifactId))
  const manifest = contextQuery.data?.manifest
  const entry = manifest?.entry
  const hasContent = contextQuery.data?.content !== undefined || entry?.type === 'sandbox_app'
  return (
    <Modal isOpen onClose={onClose} title={manifest?.title ?? title ?? 'Artifact'} size="viewport" noChildPadding>
      {contextQuery.isPending ? (
        <DocumentSkeleton label="Loading artifact" className="flex-1" />
      ) : contextQuery.isError ? (
        <p className="p-4 text-sm text-muted">Unable to load this artifact.</p>
      ) : !entry || !hasContent ? (
        <p className="p-4 text-sm text-muted">This artifact has nothing to show yet.</p>
      ) : (
        <Suspense fallback={<DocumentSkeleton label="Loading artifact" className="flex-1" />}>
          <LazyArtifactRenderer entry={entry} content={contextQuery.data.content} className="min-h-[60vh]" />
        </Suspense>
      )}
    </Modal>
  )
}

/** A squad memory note in the memory viewer. */
function MemoryNoteModal({ squadId, path, onClose }: { squadId: string; path: string; onClose: () => void }) {
  return (
    <Modal isOpen onClose={onClose} title={path.replace(/^\/memory\//, '')} size="viewport" noChildPadding>
      <Suspense fallback={<DocumentSkeleton label="Loading memory file" className="flex-1" />}>
        <LazyMemoryFileViewer squadId={squadId} filePath={path} />
      </Suspense>
    </Modal>
  )
}

/**
 * Navigates to a work stream's page in its own squad, resolved from its id or number. When it can't be
 * resolved, the chat's squad's work page shows the stream (or its own not-found state).
 */
function OpenWorkStream({
  reference,
  fallbackSquadId,
  onClose,
}: {
  reference: string
  fallbackSquadId?: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { slugFor } = useSquadSlugs()
  const workStreamQuery = useQuery({ ...queries.squads.workStreamDetail(reference), retry: false })
  const done = useRef(false)
  useEffect(() => {
    if (done.current || workStreamQuery.isPending) return
    done.current = true
    const workStream = workStreamQuery.data
    const squadId = workStream?.squadId ?? fallbackSquadId
    if (squadId) {
      const ref = workStream ? workStreamRef(workStream) : reference
      navigate(`/squads/${slugFor(squadId)}/work?ws=${encodeURIComponent(ref)}`)
    }
    onClose()
  }, [fallbackSquadId, navigate, onClose, reference, slugFor, workStreamQuery.data, workStreamQuery.isPending])
  return null
}
