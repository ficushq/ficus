/*
 * Agent behaviour evals: scenarios that check an agent still does the right thing with the
 * guidance it is given, run against two versions of that guidance (for example origin/main and
 * the working tree) so a change to the always-loaded prompt comes with evidence.
 *
 * A scenario gives an agent of one built-in type its real composed system prompt and real tool
 * definitions, then a situation as a user message. Tools are stubs: the scenario scripts what each
 * call returns. The run continues until the agent ends its turn (a reply with no tool calls) or a
 * step limit, and the scenario's grader reads the trace. See docs/wiki/agent-behaviour-evals.md.
 */

/** One tool call the agent made, with the scripted result it received. */
export interface TraceCall {
  name: string
  args: Record<string, unknown>
  result: string
}

/** One assistant turn: its visible text and the tool calls it made, in order. */
export interface TraceStep {
  text: string
  calls: TraceCall[]
}

export interface Trace {
  steps: TraceStep[]
  /** True when the agent ended its turn itself; false when the step limit stopped it. */
  ended: boolean
}

export interface Verdict {
  pass: boolean
  /** One sentence a reviewer can read without the trace. */
  reason: string
}

/**
 * Access to the variant under test, for text that production code generates (a CLI result, a
 * restart notice), so the old and new runs each read their own version of it.
 */
export interface VariantContext {
  /** Imports a module by repository-relative path from the variant (or the working tree when absent). */
  import: <T>(relativePath: string) => Promise<T>
}

/** Literal text, or text produced by the variant's own code. */
export type ScenarioText = string | ((variant: VariantContext) => string | Promise<string>)

/** What the stub tools return for a call; undefined falls through to the default responses. */
export type Responder = (
  call: { name: string; args: Record<string, unknown>; command?: string },
  variant: VariantContext
) => string | undefined | Promise<string | undefined>

/** Earlier conversation: a message the agent received, or a tool call it made and its result. */
export type HistoryEntry =
  | { user: ScenarioText }
  | { call: { name: string; args: Record<string, unknown> }; result: ScenarioText; isError?: boolean }

export type DeliveryMode =
  'pr-merge' | 'pr-auto-merge' | 'pr-review' | 'deliverable' | 'review-approval' | 'direct-merge'

export interface ScenarioFlow {
  workStreamId: string
  /** Short work number shown to the agent, for example 1250. */
  workNumber: number
  /** Adds the variant's delivery instructions for this mode as the `## Workflow delivery` section. */
  deliveryMode?: DeliveryMode
}

export interface AgentScenario {
  /** Stable id, used in reports and recordings. */
  name: string
  /** One sentence: the situation and the behaviour under test. */
  description: string
  /** Built-in agent type whose prompt is used, for example engineer, reviewer or manager. */
  agentType: string
  /** A regression here fails the comparison whatever the totals (Noah's no-regression rule). */
  must: boolean
  /** Fixture squad context; the default fixture squad is used when omitted. */
  squadContext?: string
  /** Slot pools in the fixture squad. */
  slotPools?: { key: string; capacity: number; claimTimeoutMs: number; usage?: string; hostCapacity?: number }[]
  flow?: ScenarioFlow
  /** Conversation before the turn under test (for example a command a restart cut short). */
  history?: HistoryEntry[]
  /** The messages that start the turn, in order (inbox notices, handoffs, human chat). */
  messages: ScenarioText[]
  /** Scripted tool results for this scenario; anything it does not answer gets a neutral default. */
  respond?: Responder
  /** A fresh responder for each run, when scripted results depend on earlier calls. */
  createResponder?: () => Responder
  /** Agent steps before the run stops; defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number
  grade: (trace: Trace) => Verdict
}

export const DEFAULT_MAX_STEPS = 10

export function defineScenario(scenario: AgentScenario): AgentScenario {
  return scenario
}

// ---------------------------------------------------------------------------
// Trace helpers for graders
// ---------------------------------------------------------------------------

const SHELL_TOOLS = new Set(['bash', 'squad_bash'])

export const allCalls = (trace: Trace): TraceCall[] => trace.steps.flatMap((step) => step.calls)

/** Every shell command the agent ran, in order. */
export const shellCommands = (trace: Trace): string[] =>
  allCalls(trace)
    .filter((call) => SHELL_TOOLS.has(call.name))
    .map((call) => String(call.args.command ?? ''))

export const callsTo = (trace: Trace, name: string): TraceCall[] => allCalls(trace).filter((call) => call.name === name)

/** All visible assistant text, joined. */
export const allText = (trace: Trace): string =>
  trace.steps
    .map((step) => step.text)
    .filter(Boolean)
    .join('\n')

/** The text of the last assistant step (what the turn ends with). */
export const finalText = (trace: Trace): string => trace.steps.at(-1)?.text ?? ''

/** True when some shell command matches. */
export const ran = (trace: Trace, pattern: RegExp): boolean =>
  shellCommands(trace).some((command) => pattern.test(command))

/** Index of the first call matching, across tools, or -1. */
export function firstCallIndex(trace: Trace, match: (call: TraceCall) => boolean): number {
  return allCalls(trace).findIndex(match)
}

export const pass = (reason: string): Verdict => ({ pass: true, reason })
export const fail = (reason: string): Verdict => ({ pass: false, reason })

/** Runs checks in order; the first failure is the verdict, otherwise the pass reason. */
export function allOf(passReason: string, ...checks: [boolean, string][]): Verdict {
  for (const [ok, failReason] of checks) if (!ok) return fail(failReason)
  return pass(passReason)
}

/** A question in chat text that a human must answer before work continues. */
export function endsWithChatQuestion(text: string): boolean {
  const tail = text.trim().split('\n').slice(-6).join(' ')
  return (
    /\?\s*$/.test(text.trim()) ||
    /\b(should I|shall I|do you want|would you like|want me to|let me know (if|whether|which)|which (option|one) (do|would|should) you)\b/i.test(
      tail
    )
  )
}

/** Fixture/help fidelity revision; historical recordings predate this marker and remain unchanged. */
export const HARNESS_REVISION = '2026-11-19-baseline-fixtures-v2'
