import type {
  AssistantTaskActionData,
  PendingAction,
  WorkStreamActionData,
  WorkStreamDeliveryActionData,
} from '@ficus/shared'
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

/** The web app's page for an action, for anything the farm can't handle in place. */
export function webActionUrl(actionId: string): string {
  return webAppUrl(`/actions/${encodeURIComponent(actionId)}`)
}

/** Web-app URL that opens a saved Assistant conversation (mirrors ActionItem's assistantConversationSearch). */
export function webAssistantUrl(conversationId: string, taskId?: string): string {
  const params = new URLSearchParams({ chat: 'open', assistantConversation: conversationId })
  if (taskId) params.set('assistantTask', taskId)
  return webAppUrl(`/?${params}`)
}

/** Web-app URL that opens a work stream in its squad's Work tab (mirrors the web's inboxWorkStreamLink). */
export function webWorkStreamUrl(squadId: string, workStreamRef: string | number): string {
  return webAppUrl(`/squads/${encodeURIComponent(squadId)}/work?ws=${encodeURIComponent(String(workStreamRef))}`)
}

/** The right form for one pending action, for every action type. */
export function ActionView({ action, onFocusStream, onOpenAssistant, onOpenAgent, onResolved }: ActionViewProps) {
  const typed = typedAction(action)
  // A pull request gate never takes a response here (the code host settles it), and a type newer
  // than this build links to the web app, so neither is a matter of permission.
  if (!action.canRespond && typed.type !== 'workstream-delivery' && typed.type !== 'unknown') {
    return <p className="g-action-note">You can see this, but you don't have permission to respond to it.</p>
  }
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
    case 'workstream-delivery':
      return <PullRequestGate data={typed.data} onFocusStream={onFocusStream} />
    case 'unknown':
      return (
        <div className="g-action">
          <p className="g-action-note">
            {actionTitle(action)} · {actionSubtitle(action)}. The farm doesn't know this kind of request yet.
          </p>
          <a className="g-button g-button-quiet g-verb" href={webActionUrl(action.id)}>
            <span className="g-verb-label">Open in Ficus</span>
            <span className="g-verb-help">
              {action.canRespond ? 'Handle it in the web app' : 'See it in the web app'}
            </span>
          </a>
        </div>
      )
  }
}

type DeliveryPullRequest = WorkStreamDeliveryActionData['pullRequests'][number]

/**
 * A work stream waiting on a person to review or merge its pull request on the code host. Ficus
 * can't approve or merge it, so the card says what the stream waits on, links out to the pull
 * request (one inline, several as a list, like the web's ActionItem) and opens the work stream.
 */
function PullRequestGate({
  data,
  onFocusStream,
}: {
  data: WorkStreamDeliveryActionData
  onFocusStream?: (workStreamId: string) => void
}) {
  const merge = data.deliveryKind === 'merge'
  const linked = data.pullRequests.filter((pullRequest) => pullRequest.url)
  const several = data.pullRequests.length > 1
  const what = several ? 'its pull requests' : 'its pull request'
  return (
    <div className="g-action">
      <p className="g-action-note">
        {merge ? `Waiting on someone to merge ${what}` : `Waiting on someone to review ${what}`} on the code host. The
        work stream moves on by itself once that happens.
      </p>
      {linked.length === 1 && <PullRequestLink pullRequest={linked[0]!} merge={merge} />}
      {linked.length > 1 && (
        <ul className="g-pr-list" aria-label="Pull requests">
          {linked.map((pullRequest) => (
            <li key={`${pullRequest.repository}#${pullRequest.number}`}>
              <PullRequestLink pullRequest={pullRequest} merge={merge} />
            </li>
          ))}
        </ul>
      )}
      {linked.length === 0 && <p className="g-action-note">Open the work stream in Ficus to find its pull request.</p>}
      {onFocusStream ? (
        <VerbButton
          verb="Go to plot"
          help="Show this work stream on the farm"
          tone="quiet"
          onClick={() => onFocusStream(data.workStreamId)}
        />
      ) : (
        <a
          className="g-button g-button-quiet g-verb"
          href={webWorkStreamUrl(data.squadId, data.workStreamNumber ?? data.workStreamId)}
        >
          <span className="g-verb-label">Open work stream</span>
          <span className="g-verb-help">See it in Ficus</span>
        </a>
      )}
    </div>
  )
}

/** A link out to one pull request. "Merge" would read as if clicking merges it, so a merge gate says Open. */
function PullRequestLink({ pullRequest, merge }: { pullRequest: DeliveryPullRequest; merge: boolean }) {
  const reference = `${pullRequest.repository}#${pullRequest.number}`
  return (
    <a className="g-button g-button-primary g-verb" href={pullRequest.url} target="_blank" rel="noreferrer">
      <span className="g-verb-label">{`${merge ? 'Open' : 'Review'} #${pullRequest.number}`}</span>
      <span className="g-verb-help">{`${reference} on the code host`}</span>
    </a>
  )
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
