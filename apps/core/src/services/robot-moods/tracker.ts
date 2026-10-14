import {
  isRobotMood,
  ROBOT_MODEL_MOODS,
  type DecisionRequest,
  type EventMap,
  type RobotModelMood,
  type RobotMood,
  type RobotMoodSource,
  type RobotSignalMood,
} from '@ficus/shared'
import type { DecideOptions, DecisionOutcome } from '../decisions/service'
import { redactEvidence } from '../operations-analyst/redaction'

/*
 * Robot moods (packages/shared robot-moods.ts), worked out in the worker from
 * the agent's own stream. Cheap signals come first; a decision model is asked
 * only while the agent runs, none of them is clear, at a natural boundary (a
 * tool or message ending), at most once per robot every 30s. Nothing at all
 * happens for a robot nobody is watching: its state is dropped, so memory is
 * bounded by the farm's watched set, and each robot's window is a few calls
 * and a few hundred characters.
 *
 * The tracker is fed from the runner's event subscription, so it must never
 * slow or break the stream: every entry point catches everything, and the
 * model is asked in the background.
 */

/** How many recent tool calls a robot's window keeps (and the model sees). */
export const MOOD_WINDOW_CALLS = 3
/** How much of the latest text the window keeps (and the model sees). */
export const MOOD_TEXT_TAIL = 300
/** The most a tool call's target says. */
export const MOOD_TARGET_MAX = 80
/** At most one model question per robot this often. */
export const MOOD_MODEL_INTERVAL_MS = 30_000
/** How long a mood question may take before it's dropped. */
export const MOOD_MODEL_TIMEOUT_MS = 2_000
/** The same call this many times in a row is going in circles. */
export const LOOP_REPEATS = 3
/** This many tool errors or provider retries in a row is stuck. */
export const STUCK_FAILURES = 2
/** Robots tracked at once; past this, new ones aren't (the farm sends at most 200 per viewer). */
export const MAX_TRACKED_ROBOTS = 500

export interface MoodToolCall {
  id: string
  tool: string
  /** A hash of the call's arguments, to spot the same call repeated. */
  argsKey: string
  /** What it acted on, short and redacted (a path, a command's start, a URL). */
  target: string
  result: 'running' | 'ok' | 'error'
  /** A blocking ask_human: the agent then waits for an answer. */
  blockingQuestion: boolean
}

export interface MoodWindow {
  calls: MoodToolCall[]
  /** How many calls in a row have been the same tool with the same arguments. */
  sameCallRun: number
  /** Tool errors and provider retries in a row. */
  failures: number
  /** The last MOOD_TEXT_TAIL characters the agent wrote (unredacted until it's sent). */
  text: string
  phase: 'running' | 'waiting' | 'done' | 'idle'
}

export function emptyWindow(): MoodWindow {
  return { calls: [], sameCallRun: 0, failures: 0, text: '', phase: 'running' }
}

/** The cheap signal the window shows, if any: no model needed. */
export function signalFor(window: MoodWindow): RobotSignalMood | null {
  if (window.phase === 'idle') return 'idle'
  if (window.phase === 'waiting') return 'waiting'
  if (window.phase === 'done') return 'wrapping-up'
  // Errors first: the same failing call repeated is stuck, not just circling.
  if (window.failures >= STUCK_FAILURES) return 'stuck'
  if (window.sameCallRun >= LOOP_REPEATS) return 'looping'
  return null
}

/** The few Pi session events the tracker reads (a structural subset of AgentSessionEvent). */
export type MoodEvent = { type: string } & Record<string, unknown>

const TARGET_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'file', 'url', 'pattern', 'query', 'name']

/** A short, redacted description of what a call acts on. */
export function targetOf(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  const key = TARGET_KEYS.find((name) => typeof record[name] === 'string' && record[name])
  const value = key ? (record[key] as string) : Object.values(record).find((v) => typeof v === 'string')
  if (typeof value !== 'string') return ''
  // Redaction normalizes whitespace and caps the length; cut first so it never scans a whole file.
  return redactEvidence(value.slice(0, MOOD_TARGET_MAX * 4), []).slice(0, MOOD_TARGET_MAX)
}

function argsKeyOf(tool: string, args: unknown): string {
  let json: string
  try {
    json = JSON.stringify(args) ?? ''
  } catch {
    json = String(args)
  }
  return Bun.hash(`${tool}\u0000${json}`).toString(36)
}

/** Whether a settled turn ended well: no error, not aborted, not about to be retried. */
function endedWell(event: MoodEvent): boolean {
  if (event.willRetry === true) return false
  const messages = Array.isArray(event.messages) ? (event.messages as Array<Record<string, unknown>>) : []
  return !messages.some(
    (message) => message?.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted')
  )
}

/**
 * Fold one event into a window. Returns whether it was a natural boundary (a
 * tool or an assistant message ending), the only moments the model is asked.
 */
export function applyMoodEvent(window: MoodWindow, event: MoodEvent): { boundary: boolean; changed: boolean } {
  switch (event.type) {
    case 'message_update': {
      const update = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        window.text = (window.text + update.delta).slice(-MOOD_TEXT_TAIL)
      }
      return { boundary: false, changed: false }
    }
    case 'agent_start':
      window.phase = 'running'
      window.failures = 0
      return { boundary: false, changed: true }
    case 'tool_execution_start': {
      const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
      const args = event.args
      const argsKey = argsKeyOf(tool, args)
      const last = window.calls.at(-1)
      window.sameCallRun = last && last.tool === tool && last.argsKey === argsKey ? window.sameCallRun + 1 : 1
      window.calls.push({
        id: typeof event.toolCallId === 'string' ? event.toolCallId : '',
        tool,
        argsKey,
        target: targetOf(args),
        result: 'running',
        blockingQuestion: tool === 'ask_human' && (args as { blocking?: unknown } | null)?.blocking === true,
      })
      if (window.calls.length > MOOD_WINDOW_CALLS) window.calls.splice(0, window.calls.length - MOOD_WINDOW_CALLS)
      window.phase = 'running'
      return { boundary: false, changed: true }
    }
    case 'tool_execution_end': {
      const call = window.calls.find((c) => c.id === event.toolCallId)
      const failed = event.isError === true
      if (call) call.result = failed ? 'error' : 'ok'
      window.failures = failed ? window.failures + 1 : 0
      if (!failed && call?.blockingQuestion) window.phase = 'waiting'
      return { boundary: true, changed: true }
    }
    case 'auto_retry_start':
      window.failures += 1
      return { boundary: false, changed: true }
    case 'auto_retry_end':
      if (event.success === true) window.failures = 0
      return { boundary: false, changed: true }
    case 'message_end': {
      const message = event.message as { role?: unknown } | undefined
      return { boundary: message?.role === 'assistant', changed: false }
    }
    case 'agent_end':
      if (event.willRetry === true) return { boundary: false, changed: false }
      if (window.phase !== 'waiting') window.phase = endedWell(event) ? 'done' : 'idle'
      return { boundary: false, changed: true }
    case 'agent_settled':
      if (window.phase === 'running') window.phase = 'idle'
      return { boundary: false, changed: true }
    default:
      return { boundary: false, changed: false }
  }
}

const MOOD_OPTIONS: Record<RobotModelMood, string> = {
  focused: 'Making steady progress on its task.',
  exploring: 'Reading, searching or looking around to understand something.',
  struggling: 'Hitting problems (errors, failed checks, confusion) but still trying.',
  risky:
    'About to do something consequential: deleting files or data, pushing or force-pushing, deploying, or touching secrets, credentials or permissions.',
}

const MOOD_INSTRUCTIONS =
  "The state is a coding agent's last few tool calls (oldest first, each with what it acted on and whether it " +
  'worked) and the end of what it last wrote. Which best describes how its work is going right now?'

/** The question asked of the decision model: fixed text only; the stream goes in `state`. */
export function moodRequest(window: MoodWindow): DecisionRequest {
  return {
    state: {
      recentTools: window.calls.map((call) => ({ tool: call.tool, target: call.target, result: call.result })),
      latestText: window.text ? redactEvidence(window.text, []) : '',
    },
    questions: { mood: { type: 'choice', instructions: MOOD_INSTRUCTIONS, options: { ...MOOD_OPTIONS } } },
  }
}

export type RobotMoodEvent = EventMap['agent.mood']

export interface RobotMoodTrackerDeps {
  decide: (purpose: 'robot-moods', request: DecisionRequest, options: DecideOptions) => Promise<DecisionOutcome>
  /** Whether the `robot-moods` feature is on. */
  isEnabled: () => boolean
  /** Whether the farm shows this robot to someone right now. */
  isWatched: (agentId: string) => boolean
  emit: (event: RobotMoodEvent) => void
  now?: () => number
  onError?: (error: unknown) => void
}

interface RobotState {
  squadId: string | null
  window: MoodWindow
  mood: RobotMood | null
  source: RobotMoodSource | null
  /** The model's last answer this run, to return to once a signal clears. */
  modelMood: RobotModelMood | null
  lastAskAt: number
  asking: boolean
}

export class RobotMoodTracker {
  private robots = new Map<string, RobotState>()
  private readonly now: () => number

  constructor(private readonly deps: RobotMoodTrackerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Feed one stream event. Never throws, never waits. */
  observe(agentId: string, squadId: string | null, event: MoodEvent): void {
    try {
      this.handle(agentId, squadId, event)
    } catch (error) {
      this.robots.delete(agentId)
      this.report(error)
    }
  }

  /** The current mood of every robot still tracked (and so still watched). */
  moods(): Map<string, { mood: RobotMood; source: RobotMoodSource }> {
    const out = new Map<string, { mood: RobotMood; source: RobotMoodSource }>()
    for (const [id, robot] of this.robots)
      if (robot.mood && robot.source) out.set(id, { mood: robot.mood, source: robot.source })
    return out
  }

  /** Forget robots nobody watches any more (or every robot, once the feature is off). */
  prune(): void {
    try {
      const enabled = this.deps.isEnabled()
      for (const id of this.robots.keys()) if (!enabled || !this.deps.isWatched(id)) this.robots.delete(id)
    } catch (error) {
      this.report(error)
    }
  }

  /** Tests: how much the tracker holds. */
  size(): number {
    return this.robots.size
  }

  /** Tests: one robot's window. */
  windowOf(agentId: string): MoodWindow | undefined {
    return this.robots.get(agentId)?.window
  }

  private handle(agentId: string, squadId: string | null, event: MoodEvent): void {
    // Text deltas are the busiest events: only robots already tracked look at them.
    let robot = this.robots.get(agentId)
    if (event.type === 'message_update' && !robot) return
    if (!this.deps.isWatched(agentId)) {
      if (robot) this.robots.delete(agentId)
      return
    }
    if (!robot) {
      if (this.robots.size >= MAX_TRACKED_ROBOTS) return
      robot = {
        squadId,
        window: emptyWindow(),
        mood: null,
        source: null,
        modelMood: null,
        lastAskAt: Number.NEGATIVE_INFINITY,
        asking: false,
      }
      this.robots.set(agentId, robot)
    }
    const { boundary, changed } = applyMoodEvent(robot.window, event)
    if (!changed && !boundary) return
    if (!this.deps.isEnabled()) {
      this.robots.delete(agentId)
      return
    }
    if (event.type === 'agent_start') robot.modelMood = null

    const signal = signalFor(robot.window)
    if (signal) {
      this.set(agentId, robot, signal, 'signal')
      return
    }
    // A signal that just cleared: back to what the model last said, else the plain working face.
    if (robot.source !== 'model')
      this.set(agentId, robot, robot.modelMood ?? 'focused', robot.modelMood ? 'model' : 'signal')
    if (boundary) this.maybeAsk(agentId, robot)
  }

  private maybeAsk(agentId: string, robot: RobotState): void {
    const now = this.now()
    if (robot.asking || robot.window.phase !== 'running' || now - robot.lastAskAt < MOOD_MODEL_INTERVAL_MS) return
    robot.asking = true
    robot.lastAskAt = now
    const request = moodRequest(robot.window)
    const done = (outcome: DecisionOutcome | null) => {
      robot.asking = false
      // Unwatched (or replaced) meanwhile: the answer has nowhere to go.
      if (this.robots.get(agentId) !== robot || !outcome?.ok) return
      const answer = outcome.result.answers.mood
      if (answer?.type !== 'choice' || !isModelMood(answer.choice)) return
      robot.modelMood = answer.choice
      if (signalFor(robot.window) === null && robot.window.phase === 'running')
        this.set(agentId, robot, answer.choice, 'model')
    }
    queueMicrotask(() => {
      try {
        this.deps
          .decide('robot-moods', request, {
            timeoutMs: MOOD_MODEL_TIMEOUT_MS,
            source: { kind: 'robot-mood', agentId },
          })
          .then(done, (error) => {
            done(null)
            this.report(error)
          })
      } catch (error) {
        done(null)
        this.report(error)
      }
    })
  }

  private set(agentId: string, robot: RobotState, mood: RobotMood, source: RobotMoodSource): void {
    if (robot.mood === mood) {
      robot.source = source
      return
    }
    robot.mood = mood
    robot.source = source
    try {
      this.deps.emit({ agentId, squadId: robot.squadId, mood, source, at: this.now() })
    } catch (error) {
      this.report(error)
    }
  }

  private report(error: unknown): void {
    try {
      this.deps.onError?.(error)
    } catch {
      // Reporting must not throw either.
    }
  }
}

function isModelMood(value: string): value is RobotModelMood {
  return isRobotMood(value) && (ROBOT_MODEL_MOODS as readonly string[]).includes(value)
}
