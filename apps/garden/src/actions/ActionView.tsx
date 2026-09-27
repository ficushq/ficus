import type { AssistantTaskActionData, PendingAction, WorkStreamActionData } from '@ficus/shared'
import type { ReactNode } from 'react'
import { webAppUrl } from '../api/base'
import { HaltedAgentAction } from './HaltedAgentAction'
import { typedAction } from './match'
import { actionSubtitle, actionTitle } from './present'
import { QuestionForm } from './QuestionForm'
import { ReviewForm } from './ReviewForm'
import { UnblockForm } from './UnblockForm'
import { ActionText, VerbButton } from './ui'

export interface ActionViewProps {
  action: PendingAction
  /** Show the action's plot on the farm (work stream actions). */
  onFocusStream?: (workStreamId: string) => void
  /** Open the assistant robot's chat on this conversation (and task). */
  onOpenAssistant?: (conversationId: string, taskId?: string) => void
  /** Open a robot's chat. */
  onOpenAgent?: (agentId: string) => void
  /** After the action was handled here. */
  onResolved?: () => void
}

/** The web app's page for an action, for anything the garden can't handle in place. */
export function webActionUrl(actionId: string): string {
  return webAppUrl(`/actions/${encodeURIComponent(actionId)}`)
}

/** Web-app URL that opens a saved Assistant conversation (mirrors ActionItem's assistantConversationSearch). */
export function webAssistantUrl(conversationId: string, taskId?: string): string {
  const params = new URLSearchParams({ chat: 'open', assistantConversation: conversationId })
  if (taskId) params.set('assistantTask', taskId)
  return webAppUrl(`/?${params}`)
}

/** The right form for one pending action, for every action type. */
export function ActionView({ action, onFocusStream, onOpenAssistant, onOpenAgent, onResolved }: ActionViewProps) {
  if (!action.canRespond) {
    return <p className="g-action-note">You can see this, but you don't have permission to respond to it.</p>
  }
  const typed = typedAction(action)
  switch (typed.type) {
    case 'squad-question':
      return (
        <QuestionForm
          questionData={typed.data.questionData}
          source={{ kind: 'squad-question', agentId: typed.data.agentId, squadId: typed.data.squadId }}
          onAnswered={onResolved}
          onOpenAgent={onOpenAgent}
        />
      )
    case 'agent-question':
      return (
        <QuestionForm
          questionData={typed.data.questionData}
          source={{
            kind: 'agent-question',
            questionId: typed.data.questionId,
            agentId: typed.data.agentId,
            squadId: typed.data.squadId,
            answerDelivery: typed.data.answerDelivery,
          }}
          onAnswered={onResolved}
          onOpenAgent={onOpenAgent}
        />
      )
    case 'agent-error':
      return <HaltedAgentAction action={action} onOpenAgent={onOpenAgent} onResolved={onResolved} />
    case 'workstream-review':
      return (
        <StreamAction data={typed.data} onFocusStream={onFocusStream}>
          <ReviewForm
            workStreamId={typed.data.workStreamId}
            squadId={typed.data.squadId}
            wait={typed.data.wait}
            completionMode={typed.data.completionMode}
            message={typed.data.wait.message ?? typed.data.prompt.message}
            canRespond={action.canRespond}
            onOpenAgent={onOpenAgent}
            onResolved={onResolved}
          />
        </StreamAction>
      )
    case 'workstream-blocked':
      return (
        <StreamAction data={typed.data} onFocusStream={onFocusStream}>
          <UnblockForm
            workStreamId={typed.data.workStreamId}
            squadId={typed.data.squadId}
            wait={typed.data.wait}
            prompt={typed.data.prompt}
            message={typed.data.wait.message ?? typed.data.prompt.message}
            canRespond={action.canRespond}
            onOpenAgent={onOpenAgent}
            onResolved={onResolved}
          />
        </StreamAction>
      )
    case 'assistant-needs-input':
      return <AssistantTask data={typed.data} onOpenAssistant={onOpenAssistant} />
    case 'unknown':
      return (
        <div className="g-action">
          <p className="g-action-note">
            {actionTitle(action)} · {actionSubtitle(action)}. The garden doesn't know this kind of request yet.
          </p>
          <a className="g-button g-button-quiet g-verb" href={webActionUrl(action.id)}>
            <span className="g-verb-label">Open in Ficus</span>
            <span className="g-verb-help">Handle it in the web app</span>
          </a>
        </div>
      )
  }
}

function StreamAction({
  data,
  onFocusStream,
  children,
}: {
  data: WorkStreamActionData
  onFocusStream?: (workStreamId: string) => void
  children: ReactNode
}) {
  const files = data.prompt.files ?? []
  return (
    <div className="g-action">
      {children}
      {files.length > 0 && (
        <p className="g-action-note">Attached: {files.join(', ')} (open the work stream in Ficus to download).</p>
      )}
      {onFocusStream && (
        <VerbButton
          verb="Go to plot"
          help="Show this work stream on the farm"
          tone="quiet"
          onClick={() => onFocusStream(data.workStreamId)}
        />
      )}
    </div>
  )
}

/**
 * A delegated Assistant task blocked on the owner. The answer is given inside
 * the conversation so it stays tied to the task, so this only explains and
 * opens it.
 */
function AssistantTask({
  data,
  onOpenAssistant,
}: {
  data: AssistantTaskActionData
  onOpenAssistant?: (conversationId: string, taskId?: string) => void
}) {
  return (
    <div className="g-action">
      <ActionText>{data.question}</ActionText>
      <p className="g-action-note">
        From “{data.conversationTitle}”
        {data.updateCreatedAt && (
          <>
            {' · '}
            <time dateTime={data.updateCreatedAt}>
              {new Date(data.updateCreatedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </>
        )}
        . Answer it in that Assistant conversation so the task picks it up.
      </p>
      {onOpenAssistant ? (
        <VerbButton
          verb="Answer"
          help="Open the Assistant conversation"
          tone="primary"
          onClick={() => onOpenAssistant(data.conversationId, data.taskId)}
        />
      ) : (
        <a className="g-button g-button-primary g-verb" href={webAssistantUrl(data.conversationId, data.taskId)}>
          <span className="g-verb-label">Answer</span>
          <span className="g-verb-help">Open the Assistant conversation in Ficus</span>
        </a>
      )}
    </div>
  )
}
