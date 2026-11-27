import { recommendedQuestionOption, type QuestionData, type WorkStreamPause } from '@ficus/shared'
import type { LinearAgentActivityContent } from './write-api'

/**
 * The pure half of the Linear session projector (design 6.3): from a snapshot of a bound stream, the
 * full list of writes the session should have received, each under a stable projection key. The
 * outbox inserts them with "do nothing on conflict", so projecting the same state twice sends nothing
 * new and a changed state sends only the difference.
 *
 * Everything written here is public text read in Linear. Bodies are fixed templates; the only
 * interpolated values are the pull request URL and label, the step position, the stream link (with a
 * public URL), and question text, option labels and the recommendation reason written for the person
 * answering. Step names,
 * participants, agent evidence, internal IDs and paths never appear.
 */

export type LinearOutboxKind = 'activity' | 'session_update' | 'attachment'

export interface LinearProjectionItem {
  projectionKey: string
  kind: LinearOutboxKind
  payload: Record<string, unknown>
  /** Progress that may collapse to the newest item of the session when a rate bucket is empty. */
  collapsible: boolean
}

export interface ProjectionAttempt {
  id: number
  stepId: string
  status: 'running' | 'completed' | 'returned' | 'canceled'
  kind?: string
}

export interface ProjectionQuestion {
  id: string
  status: string
  data: QuestionData
  /**
   * The option labels the answer maps to, for "Answered in Ficus: <label>". Absent for free text and
   * for a question with several items, which post "Answered in Ficus." instead.
   */
  answerLabel?: string
  /** The mirror's state when the question was already posted to this session. */
  mirrorState?: 'open' | 'answered_in_linear' | 'answered_in_ficus' | 'dismissed'
}

export interface LinearProjectionSnapshot {
  stream: {
    status: 'queued' | 'active' | 'done' | 'canceled'
    pause: (Pick<WorkStreamPause, 'id'> & { reason?: string | null }) | null
  }
  /** Step IDs in definition order with their kinds, for "step <n> of <total>". */
  steps: Array<{ id: string; kind: string }>
  attempts: ProjectionAttempt[]
  /** Attempts below this ID ran before the session was bound and are never shown. */
  attemptFloor: number
  pullRequest?: { url: string; label: string }
  /** An unrecoverable failure: the open recovery wait (recovery exhausted, waiting for a person). */
  failedWaitId?: string
  questions: ProjectionQuestion[]
  /** The stream link, only when the instance has an `https:` public URL (decision 9.5). */
  streamUrl?: string
  /** Linear's `auth` signal URL for linking an account, only with a public URL (decision 9.5). */
  authLinkUrl?: string
  lastActivityAt: Date | null
  now: Date
}

/**
 * The attempt baseline for a session bound now: attempts already finished before the binding are
 * never shown in Linear; the running ones and every later one are.
 */
export function projectionAttemptFloor(
  run: { attempts: Array<{ id: number; status: string }> } | null | undefined
): number {
  const attempts = run?.attempts ?? []
  const running = attempts.filter((attempt) => attempt.status === 'running').map((attempt) => attempt.id)
  if (running.length) return Math.min(...running)
  return attempts.reduce((max, attempt) => Math.max(max, attempt.id), 0) + 1
}

/** The pause reason a Linear stop request records (`session-prompts.ts`). */
export const LINEAR_STOP_PAUSE_REASON_PREFIX = 'Stopped from Linear by '

/** Linear marks a session stale 30 minutes after its last activity; a heartbeat comes before that. */
export const LINEAR_HEARTBEAT_MS = 25 * 60_000
/** Elicitation bodies are bounded; Linear accepts far more, but a question should stay readable. */
export const LINEAR_ELICITATION_MAX = 4_000
/** Linear's `select` signal takes 1 to 100 options. */
export const LINEAR_SELECT_MAX_OPTIONS = 100

export const LINEAR_PROJECTION_TEXT = {
  started: 'Started work.',
  approval: 'Waiting for approval in Ficus.',
  paused: 'Paused.',
  answered: 'Answered in Ficus.',
  withdrawn: 'Question withdrawn.',
  canceled: 'Ficus stopped working on this request.',
  failed: 'Ficus hit a problem and a person on the team is looking at it.',
  replyHint: 'Reply here or answer in Ficus.',
} as const

const STEP_LABELS: Record<string, string> = {
  agent: 'Working',
  decision: 'Choosing the next step',
  'human-approval': 'Waiting for approval in Ficus',
}

/** The fixed label for a step by its kind and position, e.g. "Working (step 2 of 4)". */
export function linearStepLabel(steps: LinearProjectionSnapshot['steps'], attempt: ProjectionAttempt): string {
  const index = steps.findIndex((step) => step.id === attempt.stepId)
  const kind = attempt.kind ?? steps[index]?.kind ?? 'agent'
  const label = STEP_LABELS[kind] ?? 'Working'
  return index >= 0 ? `${label} (step ${index + 1} of ${steps.length})` : label
}

function activity(
  projectionKey: string,
  content: LinearAgentActivityContent,
  options: { ephemeral?: boolean; collapsible?: boolean; signal?: string; signalMetadata?: unknown } = {}
): LinearProjectionItem {
  return {
    projectionKey,
    kind: 'activity',
    payload: {
      content,
      ...(options.ephemeral ? { ephemeral: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.signalMetadata ? { signalMetadata: options.signalMetadata } : {}),
    },
    collapsible: options.collapsible ?? false,
  }
}

function bounded(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`
}

/** The question's single item when it can be mirrored with Linear's `select` signal. */
export function selectableQuestion(data: QuestionData) {
  const [item] = data.questions
  if (data.questions.length !== 1 || !item) return undefined
  if (item.type !== 'select' && item.type !== 'multi-select') return undefined
  const options = (item.options ?? []).slice(0, LINEAR_SELECT_MAX_OPTIONS).map((option) => ({
    value: option.value,
    label: option.label?.trim() || option.value,
  }))
  return options.length ? { item, options } : undefined
}

/** "Recommended: <label>. <reason>" for a question's recommended option, so Linear shows the agent's pick. */
function recommendationLine(item: QuestionData['questions'][number]): string | undefined {
  const option = recommendedQuestionOption(item)
  if (!option) return undefined
  const label = option.label?.trim() || option.value
  const reason = option.reason?.trim()
  return `Recommended: ${label}.${reason ? ` ${reason}` : ''}`
}

/** The elicitation for a question: its text and context, the options, the recommendation, and how to answer. */
export function linearElicitation(
  question: ProjectionQuestion,
  authLinkUrl?: string
): { item: LinearProjectionItem; options: Array<{ value: string; label: string }> } {
  const parts: string[] = []
  for (const item of question.data.questions) {
    parts.push(item.question.trim())
    if (item.context?.trim()) parts.push(item.context.trim())
    if (question.data.questions.length > 1 && item.options?.length)
      parts.push(item.options.map((option) => `- ${option.label?.trim() || option.value}`).join('\n'))
    const recommendation = recommendationLine(item)
    if (recommendation) parts.push(recommendation)
  }
  const selectable = selectableQuestion(question.data)
  const hint = LINEAR_PROJECTION_TEXT.replyHint
  const body = `${bounded(parts.join('\n\n'), LINEAR_ELICITATION_MAX - hint.length - 2)}\n\n${hint}`
  const options = selectable?.options ?? []
  // Linear takes one signal per activity: an account link request wins, because without it the reply
  // can only ever be a candidate answer.
  const signal = authLinkUrl
    ? { signal: 'auth', signalMetadata: { url: authLinkUrl } }
    : selectable
      ? { signal: 'select', signalMetadata: { options } }
      : {}
  return { item: activity(`question:${question.id}:asked`, { type: 'elicitation', body }, signal), options }
}

/** Every write the session should have received for this snapshot, in the order to send them. */
export function projectLinearSession(snapshot: LinearProjectionSnapshot): LinearProjectionItem[] {
  const items: LinearProjectionItem[] = []
  const { stream } = snapshot
  const live = stream.status === 'active' || stream.status === 'queued'
  // A stream created from an event waits, paused, for its owner to prepare it; until a step runs,
  // nothing has started and nothing was paused from the session's point of view.
  const begun = snapshot.attempts.some((attempt) => attempt.id >= snapshot.attemptFloor)
  const kindOf = (attempt: ProjectionAttempt) =>
    attempt.kind ?? snapshot.steps.find((step) => step.id === attempt.stepId)?.kind
  // While a person is being waited on, a heartbeat would move the session out of "awaiting input".
  const awaitingPerson =
    snapshot.questions.some((question) => question.status === 'open') ||
    snapshot.attempts.some((attempt) => attempt.status === 'running' && kindOf(attempt) === 'human-approval')

  if (stream.status === 'active' && (begun || !stream.pause))
    items.push(
      activity('stream:started', { type: 'thought', body: LINEAR_PROJECTION_TEXT.started }, { collapsible: true })
    )

  for (const attempt of snapshot.attempts) {
    if (attempt.id < snapshot.attemptFloor) continue
    const label = linearStepLabel(snapshot.steps, attempt)
    if (attempt.status === 'running' && live)
      items.push(
        activity(
          `flow:${attempt.id}:started`,
          { type: 'action', action: 'Started', parameter: label },
          { ephemeral: true, collapsible: true }
        )
      )
    if (attempt.status === 'completed')
      items.push(
        activity(
          `flow:${attempt.id}:completed`,
          { type: 'action', action: 'Finished', parameter: label },
          { collapsible: true }
        )
      )
    const kind = attempt.kind ?? snapshot.steps.find((step) => step.id === attempt.stepId)?.kind
    if (attempt.status === 'running' && live && kind === 'human-approval')
      items.push(
        activity(
          `approval:${attempt.id}`,
          { type: 'thought', body: LINEAR_PROJECTION_TEXT.approval },
          { collapsible: true }
        )
      )
  }

  if (snapshot.pullRequest) {
    const { url, label } = snapshot.pullRequest
    items.push(activity(`pr:${url}`, { type: 'action', action: 'Opened pull request', parameter: label, result: url }))
    items.push({
      projectionKey: `pr-url:${url}`,
      kind: 'session_update',
      payload: { addedExternalUrls: [{ label: 'Pull request', url }] },
      collapsible: false,
    })
  }

  if (snapshot.streamUrl)
    items.push({
      projectionKey: 'open-in-ficus',
      kind: 'session_update',
      payload: { addedExternalUrls: [{ label: 'Open in Ficus', url: snapshot.streamUrl }] },
      collapsible: false,
    })

  for (const question of snapshot.questions) {
    if (question.status === 'open' && !question.mirrorState && live)
      items.push(linearElicitation(question, snapshot.authLinkUrl).item)
    // After the final response nothing more is said about questions; it would reopen the turn.
    if (
      live &&
      question.status !== 'open' &&
      (question.mirrorState === 'open' || question.mirrorState === 'answered_in_ficus')
    )
      items.push(
        activity(
          `question:${question.id}:resolved`,
          {
            type: 'thought',
            body:
              question.status === 'answered'
                ? question.answerLabel?.trim()
                  ? `Answered in Ficus: ${bounded(question.answerLabel.trim(), 500)}`
                  : LINEAR_PROJECTION_TEXT.answered
                : LINEAR_PROJECTION_TEXT.withdrawn,
          },
          { collapsible: true }
        )
      )
  }

  // A pause from a Linear stop request already got its "Stopped" response.
  if (live && stream.pause && begun && !stream.pause.reason?.startsWith(LINEAR_STOP_PAUSE_REASON_PREFIX))
    items.push(
      activity(
        `pause:${stream.pause.id}`,
        { type: 'thought', body: LINEAR_PROJECTION_TEXT.paused },
        { collapsible: true }
      )
    )

  // Keyed by the wait, so a later, separate failure is reported again.
  if (live && snapshot.failedWaitId)
    items.push(
      activity(`stream:failed:${snapshot.failedWaitId}`, { type: 'error', body: LINEAR_PROJECTION_TEXT.failed })
    )

  if (stream.status === 'active' && !stream.pause && !snapshot.failedWaitId && !awaitingPerson) {
    const quietFor = snapshot.lastActivityAt ? snapshot.now.getTime() - snapshot.lastActivityAt.getTime() : 0
    if (quietFor >= LINEAR_HEARTBEAT_MS) {
      const running = snapshot.attempts.find((attempt) => attempt.status === 'running')
      const label = running ? linearStepLabel(snapshot.steps, running) : 'Working'
      items.push(
        activity(
          `heartbeat:${Math.floor(snapshot.now.getTime() / LINEAR_HEARTBEAT_MS)}`,
          { type: 'thought', body: `Still working: ${label}.` },
          { ephemeral: true, collapsible: true }
        )
      )
    }
  }

  if (stream.status === 'done') {
    const body = snapshot.pullRequest
      ? `Done. Pull request: ${snapshot.pullRequest.url}.`
      : snapshot.streamUrl
        ? `Done. Details in Ficus: ${snapshot.streamUrl}`
        : 'Done.'
    items.push(activity('stream:done', { type: 'response', body }))
  }
  if (stream.status === 'canceled')
    items.push(activity('stream:canceled', { type: 'response', body: LINEAR_PROJECTION_TEXT.canceled }))
  return items
}
